## tedge-events-signed

Forward thin-edge.io events to the Cumulocity MQTT service with optional Ed25519 payload signing.

### Description

The flow subscribes to all thin-edge.io event topics (`te/+/+/+/+/e/+`) and transforms each incoming message into a Cumulocity-compatible event payload before publishing it to the Cumulocity MQTT service.

For each event message the flow:

1. Extracts the event type from the last segment of the input topic (e.g. `myEvent` from `te/device/main///e/myEvent`).
2. Reads the `device.id` from the shared flow context (populated by the `tedge-config-context` flow) and uses it as the event `source`.
3. Attaches a monotonically incrementing `tedgeSequence` counter to each outgoing message for ordering/deduplication.
4. Appends `" (from mqtt-service)"` to the event `text` field (or uses `"test event"` as the default if no `text` was provided).
5. If `private_key` is configured, computes an Ed25519 signature over the output payload and attaches it as the `_sig` field.
6. If `device_cert` is also configured, attaches the certificate as the `_cert` field (used by the verifier in PKI mode).
7. Publishes the enriched payload to the configured output topic (default: `c8y/mqtt/out/te/v1/events`).

### Payload signing

When `private_key` is set, the flow adds a `_sig` field containing a base64-encoded Ed25519 signature over the output payload (all fields except `_sig` and `_cert` themselves).

Ed25519 uses asymmetric cryptography — the device holds a **private key** that never leaves the device, and the IoT platform verifies signatures using the corresponding **public key**. This means:

- Each device has its own unique key pair
- A compromised device only affects that device's key
- The platform never holds any secret — only public keys
- No shared-secret distribution problem

The signature is computed over a canonical JSON representation of the payload where keys are sorted alphabetically and no extra whitespace is added. Verifiers must apply the same canonicalisation before verifying.

### Verification modes

The **tedge-events-verify** flow supports two complementary verification modes:

| Mode                | Config in verifier   | How device public key is found                       |
| ------------------- | -------------------- | ---------------------------------------------------- |
| **Static map**      | `public_keys` JSON   | Looked up by `source` field                          |
| **PKI certificate** | `root_ca_public_key` | Extracted from the `_cert` field signed by a root CA |

For smaller deployments or when per-device public keys are manageable, the static map mode is simpler. For larger fleets, use PKI certificate mode — the verifier only needs to know the single root CA public key.

### PKI certificate mode

In PKI mode, the device holds a certificate that binds its public key to its identity. When signing, the flow attaches the certificate to every outgoing message as `_cert`. The **tedge-events-verify** flow checks the certificate's signature against the root CA public key, then uses the embedded device public key to verify the payload signature.

Two certificate formats are supported:

#### Option A — X.509 DER certificate (from x509-cert-issuer)

Request a certificate from the **x509-cert-issuer** flow. The `cert_der` field in the response is already base64-encoded DER and can be used directly as `device_cert`. The matching `root_ca_public_key` for the verifier is extracted from the CA cert:

```sh
openssl pkey -in ca.pem -pubout -outform DER | tail -c 32 | xxd -p -c 32
```

```toml
# params.toml
private_key = "<hex-ed25519-private-key>"
device_cert = "<cert_der from x509-cert-issuer response>"
```

#### Option B — Custom JSON certificate

A lightweight JSON blob signed by any CA Ed25519 key, containing the device's public key:

```json
{
  "device_id": "my-device",
  "public_key": "<hex-encoded device public key>",
  "expires": "2027-01-01T00:00:00Z",
  "_cert_sig": "<base64 Ed25519 signature by root CA>"
}
```

This certificate is provisioned onto the device (base64-encoded) as `device_cert` in `params.toml`.

#### Generating a key pair per device

Generate a key pair and extract the raw hex bytes using `openssl`:

```sh
# Generate an Ed25519 key pair
openssl genpkey -algorithm ed25519 -out private.pem

# Extract raw private key bytes (hex) — put this in params.toml as private_key
openssl pkey -in private.pem -outform DER | tail -c 32 | xxd -p -c 32

# Extract raw public key bytes (hex) — used when creating the device certificate
openssl pkey -in private.pem -pubout -outform DER | tail -c 32 | xxd -p -c 32
```

#### Generating a root CA key pair

```sh
# Generate root CA key pair (hold this offline)
openssl genpkey -algorithm ed25519 -out ca-private.pem

# Extract root CA public key (hex) — configure this in the verifier as root_ca_public_key
openssl pkey -in ca-private.pem -pubout -outform DER | tail -c 32 | xxd -p -c 32
```

#### Creating and signing a device certificate

Use the included `device-cert.sh` script (requires `openssl`, `jq`, `xxd`):

```sh
# One-time: generate the root CA key pair
./device-cert.sh create-ca ca
# → writes ca-private.pem (keep offline) and ca-public.pem
# → prints the hex root_ca_public_key for the verifier's params.toml

# Per-device: create a signed device certificate.
# If private.pem does not exist yet it will be generated automatically.
# Prints the private_key hex (if generated) and the base64 device_cert for params.toml.
./device-cert.sh create my-device private.pem ca-private.pem 2027-01-01T00:00:00Z

# Verify a certificate at any time
./device-cert.sh verify "eyJkZXZpY2VfaWQiOi..." ca-public.pem
```

Run `./device-cert.sh` with no arguments for full usage.

Put the output in `params.toml` on the device:

```toml
private_key = "a3f1c8e2b4d69f0e..."
device_cert = "eyJkZXZpY2VfaWQiOi..."
```

### Configuration

| Parameter             | Default                     | Description                                                                                                                                                                       |
| --------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `output_events_topic` | `c8y/mqtt/out/te/v1/events` | MQTT topic where transformed events are published                                                                                                                                 |
| `private_key`         | _(empty)_                   | Hex-encoded 32-byte Ed25519 private key for signing. Leave empty to disable.                                                                                                      |
| `device_cert`         | _(empty)_                   | Base64-encoded device certificate attached as `_cert` when signing is on. Accepts either X.509 DER (the `cert_der` field returned by **x509-cert-issuer**) or a custom JSON cert. |
| `debug`               | `false`                     | When `true`, logs each incoming message payload to the console                                                                                                                    |

### Related flows

- **tedge-config-context** — populates `device.id` in the shared mapper context used by this flow as the event `source`.
- **tedge-events-verify** — verifies the signatures produced by this flow.
- **x509-cert-issuer** — issues X.509 DER device certificates; the `cert_der` response field can be used directly as `device_cert`.

## Example

### Signing

```sh
echo '[te/device/main///e/foo] {"text":"hello"}' | tedge flows test --flow ./flow.toml
```

_Output_

```sh
[c8y/mqtt/out/te/v1/events] {"text":"hello (from mqtt-service)","tedgeSequence":1,"type":"foo","payloadType":"event","source":"main","_sig":"ZSSEqAkxuraa6tnN+Ro4zpQUYd7ZQt8+PC5FRQM8j5x/bLx7WSHwAoweqGkiS2pFZuXEk6duTITNaKRP+rQBAA==","_cert":"eyJkZXZpY2VfaWQiOiJteS1kZXZpY2UiLCJleHBpcmVzIjoiMjAyNy0wMS0wMVQwMDowMDowMFoiLCJwdWJsaWNfa2V5IjoiMGNhNTFlY2ViNWUwYThhNTQ2MDNkMzZkOWMxNTM1NmY3YTQyMGUzMTVmNjJmZGI0YTA3MTk3MmFmOTJjOTRkYyIsIl9jZXJ0X3NpZyI6IkYrZTEyUVBKQmgxTHgxQkd5bU11aHdKTHlRZ3lVdGFBMFpHbFNoQjVHeGQ4TWx4Qmp3NEhSYlJNNlo3aHVuemtpN0Vad2pjTUFZVmlHNzYwR2paWUNBPT0ifQo="}
```

### End to end

```sh
echo '[te/device/main///e/foo] {"text":"hello"}' \
| tedge flows test --flow ./flow.toml \
| tedge flows test --flow ../tedge-events-verify/flow.toml
```

**Output**

```sh
[te/verified/events]  {"text":"hello (from mqtt-service)","tedgeSequence":1,"type":"foo","payloadType":"event","source":"main","_sig":"ZSSEqAkxuraa6tnN+Ro4zpQUYd7ZQt8+PC5FRQM8j5x/bLx7WSHwAoweqGkiS2pFZuXEk6duTITNaKRP+rQBAA==","_cert":"eyJkZXZpY2VfaWQiOiJteS1kZXZpY2UiLCJleHBpcmVzIjoiMjAyNy0wMS0wMVQwMDowMDowMFoiLCJwdWJsaWNfa2V5IjoiMGNhNTFlY2ViNWUwYThhNTQ2MDNkMzZkOWMxNTM1NmY3YTQyMGUzMTVmNjJmZGI0YTA3MTk3MmFmOTJjOTRkYyIsIl9jZXJ0X3NpZyI6IkYrZTEyUVBKQmgxTHgxQkd5bU11aHdKTHlRZ3lVdGFBMFpHbFNoQjVHeGQ4TWx4Qmp3NEhSYlJNNlo3aHVuemtpN0Vad2pjTUFZVmlHNzYwR2paWUNBPT0ifQo="}
```
