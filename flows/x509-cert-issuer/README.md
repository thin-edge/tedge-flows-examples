## x509-cert-issuer

An MQTT-based X.509 Certificate Authority flow. Devices that present a trusted **factory certificate** receive a real X.509 TLS client certificate they can use to authenticate to an MQTT broker's TLS endpoint.

### Description

The flow listens for certificate signing requests on a single MQTT topic. A device proves its identity by presenting a factory certificate and signs the request body with its factory private key (proof of possession). The flow issues an Ed25519 X.509 certificate signed by the configured CA, encoded as PEM and delivered back over MQTT.

The issued certificate is a standard X.509 v3 certificate and is accepted by any TLS stack that supports Ed25519 (RFC 8410) — including Mosquitto, EMQX, and OpenSSL clients.

### MQTT request/response

Publish to `te/pki/x509/csr` and subscribe to `te/pki/x509/cert/issued/<device_id>` for the response.

**Request payload:**

```json
{
  "device_id": "child-001",
  "public_key": "<base64-ed25519-public-key-for-the-new-cert>",
  "nonce": "<unique-random-string>",
  "_factory_cert": "<base64-encoded-factory-certificate-json>",
  "_req_sig": "<base64-ed25519-signature>"
}
```

`nonce` is strongly recommended — it provides anti-replay protection by ensuring each request is unique. It is required when `_req_sig` verification is performed (i.e. when `require_factory_cert = true`), and optional otherwise. Omitting it disables the anti-replay check for that request.

`_req_sig` is an Ed25519 signature of the canonical JSON of `{device_id, nonce, public_key}` (keys sorted alphabetically) using the **factory private key** embedded in `_factory_cert`. An optional `common_name` field can be included to control the certificate subject CN; it defaults to `device_id`.

**Response payload** (published to `te/pki/x509/cert/issued/<device_id>`):

```json
{
  "device_id": "child-001",
  "cert_der": "<base64-encoded-DER>",
  "cert_pem": "-----BEGIN CERTIFICATE-----\n...",
  "ca_cert_der": "<base64-encoded-DER>",
  "ca_cert_pem": "-----BEGIN CERTIFICATE-----\n..."
}
```

`cert_der` is the device's TLS client certificate in base64-encoded DER format. `ca_cert_der` is the CA certificate — install this on the broker as a trusted CA so it accepts the device cert. To convert to PEM: `echo "$cert_der" | base64 -d | openssl x509 -inform DER -out cert.pem`.

For runnable examples — including CA setup, generating factory certificates, and enrolling a device — see the [Child device enrollment example](#child-device-enrollment-example) section below.

### Configuration

| Parameter                     | Default                                | Description                                                                                                                                                                            |
| ----------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ca_private_key`              | _(required)_                           | Base64-encoded 32-byte Ed25519 private key of this CA.                                                                                                                                 |
| `ca_cert_der`                 | _(required)_                           | Base64-encoded DER of the CA certificate. Included in the response so the device can install the full chain.                                                                           |
| `factory_ca_public_keys`      | `[]`                                   | Array of base64-encoded Ed25519 public keys. A factory certificate signed by _any_ entry is accepted.                                                                                  |
| `cert_validity_days`          | `365`                                  | Validity period for issued certificates in days.                                                                                                                                       |
| `nonce_window_hours`          | `24`                                   | Time window for nonce uniqueness enforcement. Only applies to requests that include a nonce. Resets on flow restart.                                                                   |
| `require_factory_cert`        | `true`                                 | When `false`, factory certificate and request signature checks are skipped. Only use when topic access is restricted.                                                                  |
| `keygen_topic`                | `te/pki/x509/keygen`                   | Input topic for server-side key generation — flow generates the keypair on behalf of the device.                                                                                       |
| `output_cert_topic_prefix`    | `te/pki/x509/cert/issued`              | Issued certificates are published to `<prefix>/<device_id>`.                                                                                                                           |
| `output_keygen_topic_prefix`  | `te/pki/x509/keygen/issued`            | Keygen responses are published to `<prefix>/<device_id>`.                                                                                                                              |
| `renewal_topic`               | `te/pki/x509/renew`                    | Input topic for certificate renewal requests. No factory certificate is required — see below.                                                                                          |
| `output_renewal_topic_prefix` | _(same as `output_cert_topic_prefix`)_ | Renewal responses are published to `<prefix>/<device_id>`.                                                                                                                             |
| `renewal_window_days`         | _(unset)_                              | When set, only allow renewals within this many days of certificate expiry.                                                                                                             |
| `denied_device_ids`           | `[]`                                   | Array of `device_id` strings that are explicitly denied. Rejections apply to all request types (CSR, keygen, renewal). Updated at runtime — tedge reloads `params.toml` automatically. |
| `output_rejected_topic`       | `te/pki/x509/req/rejected`             | Prefix for rejected requests — device_id is appended when present (`<prefix>/<device_id>`). Empty string silently discards.                                                            |

### CA setup

The `setup-ca` command handles the one-time CA setup. It generates a CA key pair, a self-signed CA certificate, and a factory CA key, then writes a `params.toml` ready to use:

```sh
cd flows/x509-cert-issuer
./scripts/x509-cert.sh setup-ca my-ca
```

This creates `my-ca-private.pem`, `my-ca-cert.pem`, `factory-ca-private.pem`, and `params.toml`.

Configure the broker to trust the CA for client authentication. For Mosquitto, add to `mosquitto.conf`:

```
cafile /etc/mosquitto/ca-cert.pem
require_certificate true
use_identity_as_username true
```

### Enrolling devices

The full enrollment workflow has two phases: factory provisioning (done once per device by the manufacturer) and first-boot enrollment (run on the device itself). The `scripts/x509-cert.sh` helper handles both. Requires `openssl` and `mosquitto_pub`/`mosquitto_sub` for live broker enrollment.

#### Phase 1 — Factory provisioning (done once per device)

```sh
cd flows/x509-cert-issuer

DEVICE_ID="child-001"

# One-time CA setup (skip if params.toml already exists):
./scripts/x509-cert.sh setup-ca my-ca

# Generate a factory certificate for this device.
# Each device gets its own files, named by device_id to avoid overwriting when batching.
./scripts/x509-cert.sh create-factory-cert "$DEVICE_ID" factory-ca-private.pem \
  > "${DEVICE_ID}-factory-cert.b64" 2>/dev/null

echo "Burn onto the device: ${DEVICE_ID}-factory-cert.b64 + ${DEVICE_ID}-factory-device-private.pem"
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

#### Additional `enroll` modes

**Open mode — device generates its own keypair (CSR mode, no factory cert):**

```sh
./scripts/x509-cert.sh enroll child-001 --broker localhost
# Generates a new Ed25519 key at ./device-private.pem if not found.
# Pass --op-key /path/to/existing-private.pem to reuse an existing keypair.
```

**Open mode — server generates the keypair (keygen mode, no factory cert):**

```sh
./scripts/x509-cert.sh enroll child-001 --broker localhost --keygen
```

**Factory cert mode — server generates the keypair:**

```sh
./scripts/x509-cert.sh enroll child-001 --broker mqtt.local --keygen \
  --factory-cert child-001-factory-cert.b64 \
  --factory-key child-001-factory-device-private.pem \
  --out-dir ./certs
```

Full flag reference: `./scripts/x509-cert.sh enroll --help`.

### Certificate renewal

Devices that already hold a valid certificate issued by this flow can renew without presenting their factory certificate again. The device proves it still holds the corresponding private key by signing the renewal request (**proof of possession**).

```sh
# Renew with the same key:
./scripts/x509-cert.sh reenroll child-001 --broker localhost \
  --current-cert device-cert.pem --current-key device-private.pem

# Renew and rotate to a fresh keypair:
./scripts/x509-cert.sh reenroll child-001 --broker localhost \
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
  | tee /tmp/keygen-response.json \
  | jq -r '.cert_pem' \
  | ./scripts/x509-cert.sh decode-cert -

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

#### Factory certificate mode (`require_factory_cert = true`)

Factory mode requires each device to present a certificate signed by a known factory CA — cryptographic proof that the device was provisioned at manufacture time. This is the default and recommended setting for production.

Run `setup-ca` to generate the CA and factory CA together:

```sh
cd flows/x509-cert-issuer
./scripts/x509-cert.sh setup-ca my-ca    # writes params.toml with require_factory_cert = true
```

Create a factory certificate for the test device, then build and send the request:

**Keygen mode:**

```sh
DEVICE_ID="child-001"
FACTORY_CERT=$(./scripts/x509-cert.sh create-factory-cert "$DEVICE_ID" factory-ca-private.pem 2>/dev/null)
REQUEST=$(./scripts/x509-cert.sh create-keygen-req "$DEVICE_ID" factory-device-private.pem "$FACTORY_CERT")

echo "[te/pki/x509/keygen] $REQUEST" \
  | tedge flows test --flow ./flow.toml \
  | sed 's/^\[.*\] //' \
  | tee /tmp/keygen-response.json \
  | jq -r '.cert_pem' \
  | ./scripts/x509-cert.sh decode-cert -

jq -r '.private_key_pem' /tmp/keygen-response.json > device-private.pem
jq -r '.cert_pem'        /tmp/keygen-response.json > device-cert.pem
jq -r '.ca_cert_pem'     /tmp/keygen-response.json > ca-cert.pem
```

**CSR mode** (against a live broker — use the `enroll` command):

```sh
DEVICE_ID="child-001"
./scripts/x509-cert.sh create-factory-cert "$DEVICE_ID" factory-ca-private.pem \
  > "${DEVICE_ID}-factory-cert.b64" 2>/dev/null

./scripts/x509-cert.sh enroll "$DEVICE_ID" --broker localhost \
  --factory-cert "${DEVICE_ID}-factory-cert.b64" \
  --factory-key "${DEVICE_ID}-factory-device-private.pem"
```

### Advanced topics

#### Using with Mosquitto to enable TLS

A Mosquitto broker must already be running on a non-TLS endpoint.

1. Enroll the broker itself to get a server certificate (include SANs for its hostname and IP):

   ```sh
   DEVICE_ID="broker"
   BROKER="localhost"

   ./scripts/x509-cert.sh create-factory-cert "$DEVICE_ID" factory-ca-private.pem \
     > "${DEVICE_ID}-factory-cert.b64" 2>/dev/null

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
   TEDGE_CONFIG_DIR=${TEDGE_CONFIG_DIR:-/etc/tedge}
   cat <<EOT >${TEDGE_CONFIG_DIR}/mosquitto-conf/mosquitto-tls.conf
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
   mosquitto_sub -h localhost -p 8883 \
       --cafile ca-cert.pem \
       --key device-private.pem \
       --cert device-cert.pem \
       -t '#' -v
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
  "cert_der": "<base64-encoded-DER>",
  "cert_pem": "-----BEGIN CERTIFICATE-----\n...",
  "ca_cert_der": "<base64-encoded-DER>",
  "ca_cert_pem": "-----BEGIN CERTIFICATE-----\n..."
}
```

**Keygen response** (published to `te/pki/x509/keygen/issued/<device_id>`):

Same as above plus `private_key_der` and `private_key_pem` containing the generated private key.

#### Manual CA setup (without the helper script)

```sh
# Generate CA private key and self-signed certificate
openssl genpkey -algorithm ed25519 -out ca-private.pem
openssl req -new -x509 -key ca-private.pem -out ca-cert.pem -days 3650 -subj "/CN=MyDeviceCA"

# Generate factory CA
openssl genpkey -algorithm ed25519 -out factory-ca-private.pem

# Extract values for params.toml
CA_PRIV_B64=$(openssl pkey -in ca-private.pem -outform DER | tail -c 32 | base64 | tr -d '\n')
CA_CERT_DER=$(openssl x509 -in ca-cert.pem -outform DER | base64 | tr -d '\n')
FACTORY_CA_PUB=$(openssl pkey -in factory-ca-private.pem -pubout -outform DER | tail -c 32 | base64 | tr -d '\n')

cat > params.toml <<EOF
ca_private_key = "$CA_PRIV_B64"
ca_cert_der = "$CA_CERT_DER"
factory_ca_public_keys = ["$FACTORY_CA_PUB"]
require_factory_cert = true
cert_validity_days = 365
EOF
```

For open mode, omit `factory_ca_public_keys` and set `require_factory_cert = false`.

#### Manual renewal example (without the helper script)

```sh
DEVICE_ID="child-001"
NONCE=$(openssl rand -hex 16)
NEW_PUB=$(openssl pkey -in op-private.pem -pubout -outform DER | tail -c 32 | base64 | tr -d '\n')
CURRENT_CERT=$(openssl x509 -in device-cert.pem -outform DER | base64 | tr -d '\n')

# Sign {device_id, nonce, public_key} (sorted) with the CURRENT operational private key
REQ_BODY=$(printf '{"device_id":"%s","nonce":"%s","public_key":"%s"}' "$DEVICE_ID" "$NONCE" "$NEW_PUB")
REQ_SIG=$(printf '%s' "$REQ_BODY" \
  | openssl pkeyutl -sign -inkey op-private.pem -rawin \
  | base64 | tr -d '\n')

mosquitto_sub -h localhost -t "te/pki/x509/cert/issued/$DEVICE_ID" -C 1 -W 30 &
printf '{"device_id":"%s","public_key":"%s","nonce":"%s","_current_cert":"%s","_req_sig":"%s"}' \
  "$DEVICE_ID" "$NEW_PUB" "$NONCE" "$CURRENT_CERT" "$REQ_SIG" \
  | mosquitto_pub -h localhost -t te/pki/x509/renew -s
wait
```
