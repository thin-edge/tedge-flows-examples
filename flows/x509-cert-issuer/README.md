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
  "device_id": "my-device-001",
  "public_key": "<base64-ed25519-public-key-for-the-new-cert>",
  "nonce": "<unique-random-string>",
  "_factory_cert": "<base64-encoded-factory-certificate-json>",
  "_req_sig": "<base64-ed25519-signature>"
}
```

`_req_sig` is an Ed25519 signature of the canonical JSON of `{device_id, nonce, public_key}` (keys sorted alphabetically) using the **factory private key** embedded in `_factory_cert`. An optional `common_name` field can be included to control the certificate subject CN; it defaults to `device_id`.

**Response payload** (published to `te/pki/x509/cert/issued/<device_id>`):

```json
{
  "device_id": "my-device-001",
  "cert_der": "<base64-encoded-DER>",
  "cert_pem": "-----BEGIN CERTIFICATE-----\n...",
  "ca_cert_der": "<base64-encoded-DER>",
  "ca_cert_pem": "-----BEGIN CERTIFICATE-----\n..."
}
```

`cert_der` is the device's TLS client certificate in base64-encoded DER format. `ca_cert_der` is the CA certificate — install this on the broker as a trusted CA so it accepts the device cert. To convert to PEM: `echo "$cert_der" | base64 -d | openssl x509 -inform DER -out cert.pem`.

**Example using mosquitto:**

```sh
# Subscribe to receive the issued certificate
mosquitto_sub -h localhost -t "te/pki/x509/cert/issued/my-device-001" &

# Publish a certificate signing request
mosquitto_pub -h localhost -t te/pki/x509/csr -m '{
  "device_id": "my-device-001",
  "public_key": "<base64-operational-public-key>",
  "nonce": "<unique-random-value>",
  "_factory_cert": "<base64-factory-cert>",
  "_req_sig": "<base64-request-signature>"
}'
```

### Configuration

| Parameter                    | Default                         | Description                                                                                                                 |
| ---------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ca_private_key`             | *(required)*                    | Base64-encoded 32-byte Ed25519 private key of this CA.                                                                      |
| `ca_cert_der`                | *(required)*                    | Base64-encoded DER of the CA certificate. Included in the response so the device can install the full chain.                |
| `factory_ca_public_keys`     | `[]`                            | JSON array of base64-encoded Ed25519 public keys. A factory certificate signed by *any* entry is accepted.                  |
| `cert_validity_days`         | `365`                           | Validity period for issued certificates in days.                                                                            |
| `nonce_window_hours`         | `24`                            | Time window for nonce uniqueness enforcement. Resets on flow restart.                                                       |
| `require_factory_cert`       | `true`                          | When `false`, factory certificate and request signature checks are skipped. Only use when topic access is restricted.       |
| `keygen_topic`               | `te/pki/x509/keygen`            | Input topic for server-side key generation — flow generates the keypair on behalf of the device.                            |
| `output_cert_topic_prefix`   | `te/pki/x509/cert/issued`       | Issued certificates are published to `<prefix>/<device_id>`.                                                                |
| `output_keygen_topic_prefix` | `te/pki/x509/keygen/issued`     | Keygen responses are published to `<prefix>/<device_id>`.                                                                   |
| `renewal_topic`              | `te/pki/x509/renew`             | Input topic for certificate renewal requests. No factory certificate is required — see below.                               |
| `output_renewal_topic_prefix`| *(same as `output_cert_topic_prefix`)* | Renewal responses are published to `<prefix>/<device_id>`.                                                         |
| `renewal_window_days`        | *(unset)*                       | When set, only allow renewals within this many days of certificate expiry.                                                  |
| `output_rejected_topic`      | `te/pki/x509/req/rejected`      | Topic for rejected requests. Empty string silently discards.                                                                |
| `debug`                      | `false`                         | Log request outcomes to the console.                                                                                        |

### Devices without factory certificates (`require_factory_cert = false`)

For deployments where every device on the network is trusted (e.g. an isolated factory floor segment), factory certificate verification can be disabled. Any device that can publish to `te/pki/x509/csr` and provide its own keypair receives a cert — no `_factory_cert` or `_req_sig` required:

```sh
# Minimal CSR — no factory credential needed
DEVICE_ID="child-001"
openssl genpkey -algorithm ed25519 -out op-private.pem
OP_PUB=$(openssl pkey -in op-private.pem -pubout -outform DER | tail -c 32 | openssl base64 -A)
NONCE=$(openssl rand -hex 16)

jq -cn --arg id "$DEVICE_ID" --arg pub "$OP_PUB" --arg n "$NONCE" \
  '{device_id: $id, public_key: $pub, nonce: $n}' \
  | mosquitto_pub -h localhost -t te/pki/x509/csr -s
```

**Local testing with `tedge flows test`:**

```sh
DEVICE_ID="child-001"
openssl genpkey -algorithm ed25519 -out op-private.pem
OP_PUB=$(openssl pkey -in op-private.pem -pubout -outform DER | tail -c 32 | openssl base64 -A)
NONCE=$(openssl rand -hex 16)

echo "[te/pki/x509/csr] $(jq -cn --arg id "$DEVICE_ID" --arg pub "$OP_PUB" --arg n "$NONCE" \
  '{device_id: $id, public_key: $pub, nonce: $n}')" \
  | tedge flows test --flow ./flow.toml
```

To extract the cert from the output:

```sh
# Pipe the output through jq to decode the cert_der field into a PEM file
echo "[te/pki/x509/csr] $(jq -cn --arg id "$DEVICE_ID" --arg pub "$OP_PUB" --arg n "$NONCE2" \
  '{device_id: $id, public_key: $pub, nonce: $n}')" \
  | tedge flows test --flow ./flow.toml \
  | sed 's/^\[.*\] //' \
  | jq -r '.cert_der' \
  | base64 -d \
  | openssl x509 -inform DER -text -noout
```

> **Warning:** set `require_factory_cert = false` only when the MQTT broker ACLs prevent unauthorized clients from publishing to the CSR topic.

### Devices that cannot generate a secure keypair (server-side keygen)

For very constrained devices that cannot produce a cryptographically secure private key, publish to `te/pki/x509/keygen` instead. The flow generates the Ed25519 keypair and returns the private key together with the signed certificate:

**Request** (topic `te/pki/x509/keygen`):

```json
{
  "device_id": "child-001",
  "nonce": "<unique-random-string>",
  "_factory_cert": "<base64-factory-cert>",
  "_req_sig": "<base64-ed25519-signature>"
}
```

`_req_sig` covers canonical `{device_id, nonce}` (keys sorted alphabetically) — no `public_key` because the device has none yet. Omit `_factory_cert`/`_req_sig` if `require_factory_cert = false`.

**Response** (topic `te/pki/x509/keygen/issued/<device_id>`):

```json
{
  "device_id": "child-001",
  "private_key_der": "<base64-encoded-DER>",
  "private_key_pem": "-----BEGIN PRIVATE KEY-----\n...",
  "cert_der": "<base64-encoded-DER>",
  "cert_pem": "-----BEGIN CERTIFICATE-----\n...",
  "ca_cert_der": "<base64-encoded-DER>",
  "ca_cert_pem": "-----BEGIN CERTIFICATE-----\n..."
}
```

The `_pem` fields are convenience copies — they contain the same data as the corresponding `_der` fields, already converted to PEM format for direct use with Mosquitto and OpenSSL.

Shell example (with factory cert):

```sh
DEVICE_ID="child-001"
NONCE=$(openssl rand -hex 16)

# Build and sign {device_id, nonce} (sorted) with the factory private key
REQ_BODY=$(jq -cn --arg id "$DEVICE_ID" --arg n "$NONCE" \
  '{device_id: $id, nonce: $n} | to_entries | sort_by(.key) | from_entries')
REQ_SIG=$(printf '%s' "$REQ_BODY" \
  | openssl pkeyutl -sign -inkey factory-device-private.pem -rawin \
  | base64 | tr -d '\n')

# Subscribe for the response
mosquitto_sub -h localhost -t "te/pki/x509/keygen/issued/$DEVICE_ID" -C 1 -W 30 \
  > /tmp/keygen-response.json &

# Publish the keygen request
jq -cn \
  --arg id   "$DEVICE_ID" \
  --arg n    "$NONCE" \
  --arg cert "$FACTORY_CERT" \
  --arg sig  "$REQ_SIG" \
  '{device_id: $id, nonce: $n, _factory_cert: $cert, _req_sig: $sig}' \
  | mosquitto_pub -h localhost -t te/pki/x509/keygen -s

wait
# Extract and store the private key and certificates
jq -r '.private_key_pem' /tmp/keygen-response.json > device-private.pem
jq -r '.cert_pem'        /tmp/keygen-response.json > device-cert.pem
jq -r '.ca_cert_pem'     /tmp/keygen-response.json > ca-cert.pem
echo "Private key saved to device-private.pem (store securely)"
```

> **Warning:** the keygen response contains an unencrypted private key. Ensure the `te/pki/x509/keygen/issued/<device_id>` topic has strict broker ACLs so only the target device can subscribe to it.

### Certificate renewal

Devices that already have a valid certificate issued by this flow can renew it without presenting their factory certificate again. The device proves it still holds the corresponding private key by signing the renewal request with it (**proof of possession**).

Publish to `te/pki/x509/renew` and subscribe to `te/pki/x509/cert/issued/<device_id>` for the response.

**Request payload:**

```json
{
  "device_id": "my-device-001",
  "public_key": "<base64-ed25519-public-key-for-the-new-cert>",
  "nonce": "<unique-random-string>",
  "_current_cert": "<base64-DER-of-currently-held-certificate>",
  "_req_sig": "<base64-ed25519-signature>"
}
```

`_req_sig` is an Ed25519 signature of the canonical JSON of `{device_id, nonce, public_key}` (keys sorted alphabetically) using the **current operational private key** — the one corresponding to the public key in `_current_cert`. The `public_key` field is the key to certify in the renewed certificate and may be the same as the current key or a new one (key rotation).

The flow verifies that:
1. `_current_cert` was signed by this CA.
2. The CN in `_current_cert` matches `device_id`.
3. `_current_cert` has not expired.
4. `_req_sig` is valid under the public key embedded in `_current_cert` (proof of possession).

**Response payload** (published to `te/pki/x509/cert/issued/<device_id>`):

Same format as a regular CSR response — `cert_der` and `ca_cert_der`.

**Using the helper script:**

The `x509-cert.sh` helper script provides a `reenroll` command that handles this automatically:

```sh
# Renew with the same key:
./x509-cert.sh reenroll my-device-001 --broker localhost \
  --current-cert device-cert.pem --current-key device-private.pem

# Renew and rotate to a fresh keypair:
./x509-cert.sh reenroll my-device-001 --broker localhost \
  --current-cert device-cert.pem --current-key device-private.pem --rotate
```

**Shell example (manual renewal with the same key):**

```sh
DEVICE_ID="my-device-001"
NONCE=$(openssl rand -hex 16)
NEW_PUB=$(openssl pkey -in op-private.pem -pubout -outform DER | tail -c 32 | openssl base64 -A)
CURRENT_CERT=$(cat device-cert.pem | openssl x509 -outform DER | base64 | tr -d '\n')

# Sign {device_id, nonce, public_key} (sorted) with the CURRENT operational private key
REQ_BODY=$(jq -cn --arg id "$DEVICE_ID" --arg n "$NONCE" --arg pub "$NEW_PUB" \
  '{device_id: $id, nonce: $n, public_key: $pub} | to_entries | sort_by(.key) | from_entries')
REQ_SIG=$(printf '%s' "$REQ_BODY" \
  | openssl pkeyutl -sign -inkey op-private.pem -rawin \
  | base64 | tr -d '\n')

mosquitto_sub -h localhost -t "te/pki/x509/cert/issued/$DEVICE_ID" -C 1 -W 30 &
jq -cn \
  --arg id   "$DEVICE_ID" \
  --arg pub  "$NEW_PUB" \
  --arg n    "$NONCE" \
  --arg cert "$CURRENT_CERT" \
  --arg sig  "$REQ_SIG" \
  '{device_id: $id, public_key: $pub, nonce: $n, _current_cert: $cert, _req_sig: $sig}' \
  | mosquitto_pub -h localhost -t te/pki/x509/renew -s
wait
```

**Optional: restrict renewals to a window before expiry**

Set `renewal_window_days = 30` in `params.toml` to only allow renewals within 30 days of the certificate's expiry date. This limits unnecessary renewals while still allowing timely rotation:

```toml
renewal_window_days = 30
```

### CA setup

Generate a CA key pair and write the `params.toml` config file (one-time operation):

```sh
# Generate CA private key and self-signed certificate
openssl genpkey -algorithm ed25519 -out ca-private.pem
openssl req -new -x509 -key ca-private.pem -out ca-cert.pem -days 3650 -subj "/CN=MyDeviceCA"

# Generate factory CA (skip if using require_factory_cert = false)
openssl genpkey -algorithm ed25519 -out factory-ca-private.pem

# Extract values for params.toml
CA_PRIV_B64=$(openssl pkey -in ca-private.pem -outform DER | tail -c 32 | openssl base64 -A)
CA_CERT_DER=$(openssl x509 -in ca-cert.pem -outform DER | base64 | tr -d '\n')
FACTORY_CA_PUB=$(openssl pkey -in factory-ca-private.pem -pubout -outform DER | tail -c 32 | openssl base64 -A)

# Write params.toml
cat > params.toml <<EOF
ca_private_key = "$CA_PRIV_B64"
ca_cert_der = "$CA_CERT_DER"
factory_ca_public_keys = "[\\"$FACTORY_CA_PUB\\"]"
require_factory_cert = true
cert_validity_days = 365
EOF
```

For the open mode (`require_factory_cert = false`), omit `factory_ca_public_keys` and set `require_factory_cert = false` instead.

Configure the broker to trust this CA for client authentication. For Mosquitto, add to `mosquitto.conf`:

```
cafile /etc/mosquitto/ca-cert.pem
require_certificate true
use_identity_as_username true
```

### Child device enrollment example

The full workflow has two phases: factory provisioning (done once per device by the manufacturer) and first-boot enrollment (run on the device itself). Requires `openssl`, `jq`, and `mosquitto_pub`/`mosquitto_sub`.

#### Phase 1 — Factory provisioning (manufacturer, done once per device)

```sh
DEVICE_ID="child-001"

# --- Factory CA (done once, shared across all devices) ---
openssl genpkey -algorithm ed25519 -out factory-ca-private.pem
FACTORY_CA_PUB=$(openssl pkey -in factory-ca-private.pem -pubout -outform DER \
  | tail -c 32 | openssl base64 -A)
echo "Add to flow params: factory_ca_public_keys = [\"$FACTORY_CA_PUB\"]"

# --- Per-device factory keypair ---
openssl genpkey -algorithm ed25519 -out factory-device-private.pem
FACTORY_DEV_PUB=$(openssl pkey -in factory-device-private.pem -pubout -outform DER \
  | tail -c 32 | openssl base64 -A)

# --- Build the factory certificate ---
# Canonical cert body (keys must be sorted alphabetically)
CERT_BODY=$(jq -cn \
  --arg id  "$DEVICE_ID" \
  --arg pub "$FACTORY_DEV_PUB" \
  '{device_id: $id, public_key: $pub} | to_entries | sort_by(.key) | from_entries')

# Sign the canonical body with the factory CA private key
CERT_SIG=$(printf '%s' "$CERT_BODY" \
  | openssl pkeyutl -sign -inkey factory-ca-private.pem -rawin \
  | base64 | tr -d '\n')

# Assemble and base64-encode the factory certificate
FACTORY_CERT=$(jq -cn \
  --argjson body "$CERT_BODY" \
  --arg     sig  "$CERT_SIG" \
  '$body + {_cert_sig: $sig}' \
  | base64 | tr -d '\n')

echo "Factory certificate (burn this onto the device):"
echo "$FACTORY_CERT"
# Also copy factory-device-private.pem to the device's secure storage
```

#### Phase 2 — First-boot enrollment (run on the device)

```sh
DEVICE_ID="child-001"
BROKER="localhost"

# --- Generate the device's operational TLS keypair ---
openssl genpkey -algorithm ed25519 -out op-private.pem
OP_PUB=$(openssl pkey -in op-private.pem -pubout -outform DER \
  | tail -c 32 | openssl base64 -A)

# --- Generate a one-time nonce ---
NONCE=$(openssl rand -hex 16)

# --- Build and sign the request body (keys sorted: device_id, nonce, public_key) ---
REQ_BODY=$(jq -cn \
  --arg id  "$DEVICE_ID" \
  --arg n   "$NONCE" \
  --arg pub "$OP_PUB" \
  '{device_id: $id, nonce: $n, public_key: $pub} | to_entries | sort_by(.key) | from_entries')

REQ_SIG=$(printf '%s' "$REQ_BODY" \
  | openssl pkeyutl -sign -inkey factory-device-private.pem -rawin \
  | base64 | tr -d '\n')

# --- Subscribe for the response (background, wait up to 30 s) ---
mosquitto_sub -h "$BROKER" -t "te/pki/x509/cert/issued/$DEVICE_ID" \
  -C 1 -W 30 > /tmp/cert-response.json &

# --- Publish the certificate signing request ---
jq -cn \
  --arg id   "$DEVICE_ID" \
  --arg pub  "$OP_PUB" \
  --arg n    "$NONCE" \
  --arg cert "$FACTORY_CERT" \
  --arg sig  "$REQ_SIG" \
  '{device_id: $id, public_key: $pub, nonce: $n, _factory_cert: $cert, _req_sig: $sig}' \
  | mosquitto_pub -h "$BROKER" -t te/pki/x509/csr -s

# --- Wait for the response and extract the certificates ---
wait
CERT_DER=$(jq -r '.cert_der'    /tmp/cert-response.json)
CA_CERT_DER=$(jq -r '.ca_cert_der' /tmp/cert-response.json)

# Convert DER → PEM
printf '%s' "$CERT_DER"    | base64 -d | openssl x509 -inform DER -out device-cert.pem
printf '%s' "$CA_CERT_DER" | base64 -d | openssl x509 -inform DER -out ca-cert.pem

# Verify the cert chain
openssl verify -CAfile ca-cert.pem device-cert.pem

echo "Enrollment complete. Use op-private.pem + device-cert.pem for TLS client auth."
```

The device now has `op-private.pem` (private key) and `device-cert.pem` (TLS client certificate) ready to use. `ca-cert.pem` is the CA certificate that should be installed on the MQTT broker as a trusted CA.

#### Local testing with `tedge flows test`

The simplest way to test locally is to set `require_factory_cert = false` in `params.toml` and use the keygen topic — the flow generates the keypair, so only a `device_id` and `nonce` are needed:

```sh
cd flows/x509-cert-issuer

DEVICE_ID="child-001"
NONCE=$(openssl rand -hex 16)

echo "[te/pki/x509/keygen] $(jq -cn --arg id "$DEVICE_ID" --arg n "$NONCE" \
  '{device_id: $id, nonce: $n}')" \
  | tedge flows test --flow ./flow.toml \
  | sed 's/^\[.*\] //' \
  | tee /tmp/keygen-response.json \
  | jq -r '.cert_pem' \
  | ./scripts/x509-cert.sh decode-cert -
```

Save the generated private key and certificate from the same response:

```sh
jq -r '.private_key_pem' /tmp/keygen-response.json > device-private.pem
jq -r '.cert_pem'        /tmp/keygen-response.json > device-cert.pem
jq -r '.ca_cert_pem'     /tmp/keygen-response.json > ca-cert.pem
```

**With a factory certificate (`require_factory_cert = true`):**

Uses the helper script to build the factory cert and signed keygen request. Run `setup-ca` first if you don't already have a `params.toml`:

```sh
cd flows/x509-cert-issuer

./scripts/x509-cert.sh setup-ca my-ca    # writes params.toml with require_factory_cert = true

DEVICE_ID="child-001"
FACTORY_CERT=$(./scripts/x509-cert.sh create-factory-cert "$DEVICE_ID" factory-ca-private.pem 2>/dev/null)
REQUEST=$(./scripts/x509-cert.sh create-keygen-req "$DEVICE_ID" factory-device-private.pem "$FACTORY_CERT")

echo "[te/pki/x509/keygen] $REQUEST" \
  | tedge flows test --flow ./flow.toml \
  | sed 's/^\[.*\] //' \
  | tee /tmp/keygen-response.json \
  | jq -r '.cert_pem' \
  | ./scripts/x509-cert.sh decode-cert -
```

Save the generated private key and certificate from the same response:

```sh
jq -r '.private_key_pem' /tmp/keygen-response.json > device-private.pem
jq -r '.cert_pem'        /tmp/keygen-response.json > device-cert.pem
jq -r '.ca_cert_pem'     /tmp/keygen-response.json > ca-cert.pem
```

#### Enrolling against a live MQTT broker with `enroll`

Once the flow is running on a real thin-edge.io device you can enroll new clients with the `enroll` command in `scripts/x509-cert.sh`. It subscribes for the response *before* publishing (to avoid race conditions), then writes `device-private.pem`, `device-cert.pem`, and `ca-cert.pem` directly to disk.

**Open mode (`require_factory_cert = false`) — server generates the keypair:**

```sh
cd flows/x509-cert-issuer

./scripts/x509-cert.sh enroll child-001 --broker localhost --keygen
```

**Factory cert mode (`require_factory_cert = true`) — server generates the keypair:**

```sh
cd flows/x509-cert-issuer

# One-time CA setup (skip if params.toml already exists)
./scripts/x509-cert.sh setup-ca my-ca

# Create the factory certificate for this device ID
FACTORY_CERT=$(./scripts/x509-cert.sh create-factory-cert child-001 factory-ca-private.pem 2>/dev/null)

# Enroll — writes device-private.pem, device-cert.pem, ca-cert.pem to ./certs/
./scripts/x509-cert.sh enroll child-001 --broker mqtt.local --keygen \
  --factory-cert "$FACTORY_CERT" --factory-key factory-device-private.pem \
  --out-dir ./certs
```

**Device supplies its own keypair (CSR mode):**

```sh
./scripts/x509-cert.sh enroll child-001 --broker mqtt.local \
  --factory-cert "$FACTORY_CERT" --factory-key factory-device-private.pem \
  --out-dir ./certs
# A new Ed25519 key is generated at ./certs/device-private.pem if not found.
# Pass --op-key /path/to/existing-private.pem to reuse an existing keypair.
```

Full flag reference: `./scripts/x509-cert.sh enroll --help` or see the usage header in the script.

### Using with mosquitto to enable TLS

A mosquitto broker must be already configure and running on a non-TLS endpoint.

1. Create certificate for the broker

    ```sh
    ./x509-cert.sh enroll broker --broker localhost --keygen \
    --san-dns localhost --san-dns "$HOST" \
    --san-ip 127.0.0.1
    ```

1. Copy the certificates

    ```sh
    mkdir -p /etc/mosquitto/certs/
    cp device-private.pem  /etc/mosquitto/certs/broker-private.pem
    cp device-cert.pem /etc/mosquitto/certs/broker-cert.pem
    cp ca-cert.pem /etc/mosquitto/certs/ca-cert.pem
    ```

1. Create a mosquitto TLS listener

    ```sh
    TEDGE_CONFIG_DIR=${TEDGE_CONFIG_DIR:-/etc/tedge}
    cat <<EOT >${TEDGE_CONFIG_DIR}/mosquitto-conf/mosquitto-tls.conf
    # TLS listener on port 8883
    listener 8883

    # CA certificate used to verify connecting client certificates.
    # Certificates issued by the x509-cert-issuer flow are signed by this CA.
    cafile /etc/mosquitto/certs/ca-cert.pem

    # Server certificate and private key.
    certfile /etc/mosquitto/certs/broker-cert.pem
    keyfile /etc/mosquitto/certs/broker-private.pem


    # Require clients to present a valid certificate signed by the CA above.
    require_certificate true

    # Use the certificate's Common Name (CN) as the MQTT client username.
    # This lets you apply per-device ACL rules based on the CN.
    use_identity_as_username true
    EOT
    ```

1. Restart mosquitto

    ```sh
    systemctl restart mosquitto
    ```

1. Create a child certificate and use it to connect to the broker

    ```sh
    mosquitto_sub -h localhost -p 8883 \
        --cafile ca-cert.pem \
        --key device-private.pem \
        --cert device-cert.pem \
        -t '#' -v --debug
    ```

### Related flows

- **pki-issuer** — issues a simpler application-layer JSON certificate for payload signing, without needing a full X.509 CA.
