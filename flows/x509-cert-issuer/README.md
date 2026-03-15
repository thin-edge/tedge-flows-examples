## x509-cert-issuer

An MQTT-based X.509 Certificate Authority flow. Devices that present a trusted **factory certificate** receive a X.509 TLS client certificate they can use to authenticate to an MQTT broker's TLS endpoint (or another other service which requires mutual TLS authentication).

### Description

The flow listens on two enrollment topics: a CSR topic where the device provides its own public key, and a keygen topic where the flow generates the keypair on the device's behalf. A device proves its identity by presenting a factory certificate and signs the request body with its factory private key (proof of possession). The flow issues an Ed25519 X.509 certificate signed by the configured CA, encoded as PEM and delivered back over MQTT.

The issued certificate is a standard X.509 v3 certificate and is accepted by any TLS stack that supports Ed25519 (RFC 8410) — including Mosquitto, EMQX, and OpenSSL clients.

For the full MQTT request/response format, see the [MQTT protocol reference](#mqtt-protocol-reference).

### Configuration

| Parameter                     | Default                                | Description                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ca_private_key`              | _(required)_                           | Base64-encoded 32-byte Ed25519 private key of this CA.                                                                                                                                                                                                                                                                     |
| `ca_cert_der`                 | _(required)_                           | Base64-encoded DER of the CA certificate. Included in the response so the device can install the full chain.                                                                                                                                                                                                               |
| `factory_ca_public_keys`      | `[]`                                   | Array of base64-encoded Ed25519 public keys. A factory certificate signed by _any_ entry is accepted.                                                                                                                                                                                                                      |
| `cert_validity_days`          | `365`                                  | Validity period for issued certificates in days.                                                                                                                                                                                                                                                                           |
| `nonce_window_hours`          | `24`                                   | Time window for nonce uniqueness enforcement. Only applies to requests that include a nonce. Resets on flow restart.                                                                                                                                                                                                       |
| `require_factory_cert`        | `true`                                 | When `false`, factory certificate and request signature checks are skipped. Only use when topic access is restricted.                                                                                                                                                                                                      |
| `keygen_topic`                | `te/pki/x509/keygen`                   | Input topic for server-side key generation — flow generates the keypair on behalf of the device.                                                                                                                                                                                                                           |
| `output_cert_topic_prefix`    | `te/pki/x509/cert/issued`              | Issued certificates are published to `<prefix>/<device_id>`.                                                                                                                                                                                                                                                               |
| `output_keygen_topic_prefix`  | `te/pki/x509/keygen/issued`            | Keygen responses are published to `<prefix>/<device_id>`.                                                                                                                                                                                                                                                                  |
| `renewal_topic`               | `te/pki/x509/renew`                    | Input topic for certificate renewal requests. No factory certificate is required — see below.                                                                                                                                                                                                                              |
| `output_renewal_topic_prefix` | _(same as `output_cert_topic_prefix`)_ | Renewal responses are published to `<prefix>/<device_id>`.                                                                                                                                                                                                                                                                 |
| `renewal_window_days`         | _(unset)_                              | When set, only allow renewals within this many days of certificate expiry.                                                                                                                                                                                                                                                 |
| `denied_device_ids`           | `[]`                                   | Coarse device-level block — rejects all request types for the listed `device_id` strings, even after the certificate is revoked and the device is re-provisioned. Prefer `revoked_cert_serials` + `denied_factory_pubkeys` for revocation.                                                                                 |
| `revoked_cert_serials`        | `[]`                                   | CRL-style serial revocation (RFC 5280). Array of lowercase hex certificate serial numbers. Blocks **renewal** of those specific certificates without blocking future re-enrollment — after the device re-enrolls it gets a fresh serial and is unblocked. Every issuance response includes `cert_serial` for easy capture. |
| `denied_factory_pubkeys`      | `[]`                                   | Array of base64-encoded Ed25519 public keys of factory certificates that are no longer trusted. Blocks enrollment using that specific credential without permanently blocking the device identity — re-provisioning the device with a new factory key (fresh burn at the factory) restores enrollment capability.          |
| `output_rejected_topic`       | `te/pki/x509/req/rejected`             | Prefix for rejected requests — device_id is appended when present (`<prefix>/<device_id>`). Empty string silently discards.                                                                                                                                                                                                |

### CA setup

The `setup-ca` command handles the one-time CA setup. It generates a CA key pair, a self-signed CA certificate, and a factory CA key, then writes a `params.toml` ready to use:

```sh
cd flows/x509-cert-issuer
./scripts/x509-cert.sh setup-ca my-ca
```

This creates `my-ca-private.pem`, `my-ca-cert.pem`, `factory-ca-private.pem`, and `params.toml`.

To configure Mosquitto to use the CA for TLS client authentication, see [Using with Mosquitto to enable TLS](#using-with-mosquitto-to-enable-tls).

### Enrolling devices

The full enrollment workflow has two phases: factory provisioning (done once per device by the manufacturer) and first-boot enrollment (run on the device itself). The `scripts/x509-cert.sh` helper handles both. Requires `openssl` and `mosquitto_pub`/`mosquitto_sub` for live broker enrollment.

#### Phase 1 — Factory provisioning (done once per device)

```sh
cd flows/x509-cert-issuer

DEVICE_ID="child-001"

# One-time CA setup (skip if params.toml already exists):
./scripts/x509-cert.sh setup-ca my-ca

# Generate a factory certificate for this device.
# Writes ${DEVICE_ID}-factory-cert.b64 and ${DEVICE_ID}-factory-device-private.pem to the current directory.
./scripts/x509-cert.sh create-factory-cert "$DEVICE_ID" factory-ca-private.pem

# Copy both files to the device's secure storage:
scp "${DEVICE_ID}-factory-device-private.pem" \
    "${DEVICE_ID}-factory-cert.b64" \
    user@"$DEVICE_ID":/home/user/
```

#### Phase 2 — First-boot enrollment (run on the device)

```sh
DEVICE_ID="child-001"
BROKER="localhost"

# Enroll: subscribes for the response, generates the operational keypair, then writes the cert files.
./scripts/x509-cert.sh enroll "$DEVICE_ID" --broker "$BROKER" \
  --factory-cert "${DEVICE_ID}-factory-cert.b64" \
  --factory-key "${DEVICE_ID}-factory-device-private.pem"

echo "Enrollment complete. Use device-private.pem + device-cert.pem for TLS client auth."
```

The device now has `device-private.pem` (private key) and `device-cert.pem` (TLS client certificate). `ca-cert.pem` is the CA certificate to install on the MQTT broker as a trusted CA.

Full flag reference: `./scripts/x509-cert.sh enroll --help`.

### Certificate revocation

The flow supports two revocation mechanisms that are more precise than the simple `denied_device_ids` setting:

#### Serial-based revocation (`revoked_cert_serials`) — RFC 5280 CRL style

Every issued certificate has a unique serial number, which is returned as `cert_serial` in the issuance response and logged at issuance time. To revoke a specific certificate without permanently blocking the device:

1. Record the `cert_serial` value from the issuance response (or from the server log).
2. Add it to `revoked_cert_serials` in `params.toml`:

   ```toml
   revoked_cert_serials = ["3a9f2c1b..."]
   ```

The flow immediately rejects any renewal request that presents that specific certificate. Critically, the device can still **re-enroll** using its factory certificate — once re-enrolled it receives a fresh serial and the revocation entry no longer applies.

This is the same model that X.509 Certificate Revocation Lists (CRLs, RFC 5280) use: compromise of a certificate revokes that certificate's serial number, not the device identity.

#### Factory credential revocation (`denied_factory_pubkeys`)

If the factory private key itself is compromised (an attacker could forge new factory certificates), add the base64-encoded public key of the compromised factory certificate to `denied_factory_pubkeys`:

```toml
denied_factory_pubkeys = ["<base64-ed25519-pubkey>"]
```

This blocks enrollment using that specific factory credential without permanently blocking the device identity. Re-provisioning the device at the factory with a new keypair (fresh burn) restores enrollment capability.

This is analogous to revoking an intermediate CA certificate: it invalidates all enrollments that depend on that credential without affecting devices that were provisioned by a different factory CA.

#### When to use `denied_device_ids`

`denied_device_ids` permanently blocks the device identity regardless of what certificate it presents. It is appropriate as a last resort (e.g. a stolen device that cannot be physically recovered and re-provisioned). For the common case of a compromised operational certificate, prefer `revoked_cert_serials`.

---

### Certificate renewal

Devices that already hold a valid certificate issued by this flow can renew without presenting their factory certificate again. The device proves it still holds the corresponding private key by signing the renewal request (**proof of possession**).

```sh
DEVICE_ID="child-001"
BROKER="localhost"

# Renew with the same key:
./scripts/x509-cert.sh reenroll "$DEVICE_ID" --broker "$BROKER" \
  --current-cert device-cert.pem --current-key device-private.pem

# Renew and rotate to a fresh keypair:
./scripts/x509-cert.sh reenroll "$DEVICE_ID" --broker "$BROKER" \
  --current-cert device-cert.pem --current-key device-private.pem --rotate
```

**Optional: restrict renewals to a window before expiry**

Set `renewal_window_days = 30` in `params.toml` to only allow renewals within 30 days of the certificate's expiry date:

```toml
renewal_window_days = 30
```

### Local testing with `tedge flows test`

`tedge flows test` runs the flow against a single message without needing a live broker. Requires `openssl`.

#### Open mode (`require_factory_cert = false`)

Open mode skips factory certificate verification — any device that can reach the broker gets a cert. It's the easiest starting point and useful for isolated networks or local testing.

Run `setup-ca` once to generate the CA key pair and a `params.toml`, then switch to open mode:

```sh
cd flows/x509-cert-issuer
./scripts/x509-cert.sh setup-ca my-ca
# Edit params.toml and set: require_factory_cert = false
```

> **Warning:** use open mode only when MQTT broker ACLs prevent unauthorized clients from publishing to the CSR topic.

**Keygen mode** — the flow generates the device keypair (no device-side crypto required):

```sh
DEVICE_ID="child-001"
NONCE=$(openssl rand -hex 16)

printf '[te/pki/x509/keygen] {"device_id":"%s","nonce":"%s"}' "$DEVICE_ID" "$NONCE" \
  | tedge flows test --flow ./flow.toml \
  | sed 's/^\[.*\] //' \
  | tee /tmp/keygen-response.json

# Save the generated private key and certificates:
jq -r '.private_key_pem' /tmp/keygen-response.json > device-private.pem
jq -r '.cert_pem'        /tmp/keygen-response.json > device-cert.pem
jq -r '.ca_cert_pem'     /tmp/keygen-response.json > ca-cert.pem
```

> **Warning:** the keygen response contains an unencrypted private key. In production, ensure the `te/pki/x509/keygen/issued/<device_id>` topic has strict broker ACLs so only the target device can subscribe to it.

**CSR mode** — the device generates its own keypair:

```sh
DEVICE_ID="child-001"
openssl genpkey -algorithm ed25519 -out op-private.pem
OP_PUB=$(openssl pkey -in op-private.pem -pubout -outform DER | tail -c 32 | base64 | tr -d '\n')
NONCE=$(openssl rand -hex 16)

PAYLOAD=$(printf '{"device_id":"%s","nonce":"%s","public_key":"%s"}' \
  "$DEVICE_ID" "$NONCE" "$OP_PUB")
echo "[te/pki/x509/csr] $PAYLOAD" \
  | tedge flows test --flow ./flow.toml
```

For factory certificate mode, use the `enroll` command against a live broker — see [Enrolling devices](#enrolling-devices).

### Advanced topics

#### Using with Mosquitto to enable TLS

A Mosquitto broker must already be running on a non-TLS endpoint.

1. Enroll the broker itself to get a server certificate (include SANs for its hostname and IP):

   ```sh
   DEVICE_ID="broker"
   BROKER="localhost"

   ./scripts/x509-cert.sh create-factory-cert "$DEVICE_ID" factory-ca-private.pem

   ./scripts/x509-cert.sh enroll "$DEVICE_ID" --broker "$BROKER" --keygen \
     --san-dns localhost --san-dns "$HOST" \
     --san-ip 127.0.0.1 \
     --factory-cert "${DEVICE_ID}-factory-cert.b64" \
     --factory-key "${DEVICE_ID}-factory-device-private.pem"
   ```

1. Copy the certificates into place:

   ```sh
   mkdir -p /etc/mosquitto/certs/
   cp device-private.pem /etc/mosquitto/certs/broker-private.pem
   cp device-cert.pem    /etc/mosquitto/certs/broker-cert.pem
   cp ca-cert.pem        /etc/mosquitto/certs/ca-cert.pem
   ```

1. Create a Mosquitto TLS listener:

   ```sh
   TEDGE_CONFIG_DIR="${TEDGE_CONFIG_DIR:-/etc/tedge}"
   cat <<EOT > "${TEDGE_CONFIG_DIR}/mosquitto-conf/mosquitto-tls.conf"
   # TLS listener on port 8883
   listener 8883

   # CA certificate used to verify connecting client certificates.
   cafile /etc/mosquitto/certs/ca-cert.pem

   # Server certificate and private key.
   certfile /etc/mosquitto/certs/broker-cert.pem
   keyfile /etc/mosquitto/certs/broker-private.pem

   # Require clients to present a valid certificate signed by the CA.
   require_certificate true

   # Use the certificate CN as the MQTT client username (enables per-device ACLs).
   use_identity_as_username true
   EOT
   ```

1. Restart Mosquitto:

   ```sh
   systemctl restart mosquitto
   ```

1. Connect using a device certificate:

   ```sh
   mosquitto_sub -h "$BROKER" -p 8883 \
   --capath /etc/ssl/certs \
   --key device-private.pem \
   --cert device-cert.pem \
   -t '#' -v
   ```

   **Optional: Configure the tedge-agent to use the certificate**

   ```sh
   # copy certificate to the expected paths
   cp device-cert.pem "$(tedge config get device.cert_path)"
   cp device-private.pem "$(tedge config get device.key_path)"

   tedge config set mqtt.client.auth.cert_file "$(tedge config get device.cert_path)"
   tedge config set mqtt.client.auth.key_file "$(tedge config get device.key_path)"
   tedge config set http.client.auth.cert_file "$(tedge config get device.cert_path)"
   tedge config set http.client.auth.key_file "$(tedge config get device.key_path)"
   tedge config set c8y.proxy.cert_path "$(tedge config get device.cert_path)"
   tedge config set c8y.proxy.key_path "$(tedge config get device.key_path)"

   # add the ca certificate
   cp ca-cert.pem /usr/local/share/ca-certificates/mosquitto-ca-cert.crt
   update-ca-certificates

   # configure the tedge-agent to use the certificate
   tedge config set mqtt.client.host "$BROKER"
   tedge config set mqtt.client.port "8883"

   # verify
   tedge mqtt sub '#'
   ```

#### Renewing the CA certificate

The CA certificate expires after the validity period set at generation time (`setup-ca` uses 10 years). When it approaches expiry, re-issue it from the **same private key** — all previously issued device certificates remain valid because they were signed by that key:

```sh
cd flows/x509-cert-issuer
./scripts/x509-cert.sh renew-ca my-ca-private.pem my-ca-cert.pem
```

This overwrites `my-ca-cert.pem` with a fresh cert and updates `ca_cert_der` in `params.toml` in place. Then:

1. Copy the updated `params.toml` to the flow working directory — tedge reloads it automatically.
2. Replace the broker's `cafile` with the new `my-ca-cert.pem` and restart the broker.
3. Push the new CA cert to any devices that have it cached.

> Rotating the **CA private key** is more disruptive — all issued device certificates become invalid and every device must re-enroll from scratch.

#### MQTT protocol reference

The following documents the raw MQTT request/response format for clients that do not use the `x509-cert.sh` helper.

**CSR request** (publish to `te/pki/x509/csr`, subscribe to `te/pki/x509/cert/issued/<device_id>`):

```json
{
  "device_id": "child-001",
  "public_key": "<base64-ed25519-public-key>",
  "nonce": "<unique-random-string>",
  "_factory_cert": "<base64-encoded-factory-certificate-json>",
  "_req_sig": "<base64-ed25519-signature>"
}
```

`_factory_cert` and `_req_sig` are only required when `require_factory_cert = true`. `nonce` is recommended for anti-replay protection; it is required when `_req_sig` is present.

`_req_sig` is an Ed25519 signature of the canonical JSON of `{device_id, nonce, public_key}` (keys sorted alphabetically) using the factory private key.

**Keygen request** (publish to `te/pki/x509/keygen`, subscribe to `te/pki/x509/keygen/issued/<device_id>`):

```json
{
  "device_id": "child-001",
  "nonce": "<unique-random-string>",
  "_factory_cert": "<base64-factory-cert>",
  "_req_sig": "<base64-ed25519-signature>"
}
```

No `public_key` field — the flow generates the keypair. `_req_sig` covers `{device_id, nonce}` (sorted). Omit `_factory_cert`/`_req_sig` if `require_factory_cert = false`.

**Renewal request** (publish to `te/pki/x509/renew`, subscribe to `te/pki/x509/cert/issued/<device_id>`):

```json
{
  "device_id": "child-001",
  "public_key": "<base64-ed25519-public-key-for-new-cert>",
  "nonce": "<unique-random-string>",
  "_current_cert": "<base64-DER-of-currently-held-certificate>",
  "_req_sig": "<base64-ed25519-signature>"
}
```

`_req_sig` covers `{device_id, nonce, public_key}` (sorted) signed with the **current operational private key** — the one matching the public key in `_current_cert`. The flow verifies that `_current_cert` was issued by this CA, the CN matches `device_id`, the cert has not expired, and the signature is valid.

**CSR/Renewal response** (published to `te/pki/x509/cert/issued/<device_id>`):

```json
{
  "device_id": "child-001",
  "cert_serial": "<lowercase-hex-serial>",
  "cert_der": "<base64-encoded-DER>",
  "cert_pem": "-----BEGIN CERTIFICATE-----\n...",
  "ca_cert_der": "<base64-encoded-DER>",
  "ca_cert_pem": "-----BEGIN CERTIFICATE-----\n..."
}
```

`cert_serial` is the hex-encoded X.509 serial number of the issued certificate. Record it if you may need to revoke this specific certificate later via `revoked_cert_serials`.

**Keygen response** (published to `te/pki/x509/keygen/issued/<device_id>`):

Same as above plus `private_key_der` and `private_key_pem` containing the generated private key.
