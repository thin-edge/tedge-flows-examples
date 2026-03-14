## tedge-events-verify

Verify Ed25519 signatures on events produced by the **tedge-events-signed** flow.

### Description

The flow subscribes to the signed events topic and validates the `_sig` field in each message. Messages with a valid signature are forwarded to `output_verified_topic`. Messages with a missing, invalid, or unrecognised signature are forwarded to `output_rejected_topic` (useful for alerting or auditing).

Two verification modes are supported:

- **Static map mode** — each device's public key is pre-registered in the `public_keys` config parameter. Simpler to set up, suitable for smaller fleets.
- **PKI certificate mode** — a single root CA public key is configured. Each message carries a `_cert` field (a device certificate issued by the root CA), from which the device's public key is extracted at verify time. No per-device platform config is needed.

Two certificate formats are accepted in PKI mode, auto-detected by the first byte of the decoded `_cert` value:

| Format | Issued by | Detection |
|---|---|---|
| X.509 DER | **x509-cert-issuer** flow | First byte = `0x30` (ASN.1 SEQUENCE) |
| JSON cert | Custom / manual | All other bytes (JSON `{...}`) |

### Signature verification

The signature covers a canonical JSON representation of the payload — all fields except `_sig` and `_cert`, with keys sorted alphabetically and no extra whitespace. This matches the canonicalisation used by **tedge-events-signed**.

### PKI certificate mode

When `root_ca_public_key` is set, the verifier performs a two-step check:

1. Decode the `_cert` field (base64 → DER or JSON) and verify its signature against the root CA public key.
2. Extract the device's public key from the certificate and verify the payload's `_sig`.

#### Using X.509 certificates from x509-cert-issuer

Set `root_ca_public_key` to the raw hex of the CA's Ed25519 public key. Extract it from the CA cert with:

```sh
openssl pkey -in ca.pem -pubout -outform DER | tail -c 32 | xxd -p -c 32
```

Set `device_cert` in **tedge-events-signed** to the `cert_der` value returned by **x509-cert-issuer** (already base64-encoded DER):

```toml
# tedge-events-signed params.toml
private_key = "<hex-ed25519-private-key>"
device_cert = "<cert_der from x509-cert-issuer response>"

# tedge-events-verify params.toml
root_ca_public_key = "<hex-ca-public-key>"
```

#### Using a custom JSON certificate

The `_cert` field can also carry a base64-encoded JSON certificate issued by any tool that produces this format:

```json
{
  "device_id": "my-device",
  "public_key": "<hex-encoded device public key>",
  "expires": "2027-01-01T00:00:00Z",
  "_cert_sig": "<base64 Ed25519 signature by root CA>"
}
```

Optionally, certificates can include an `expires` field (ISO 8601). Expired certificates are rejected in both formats.

### Configuration

| Parameter               | Default                          | Description                                                                                               |
| ----------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `root_ca_public_key`    | *(empty)*                        | Hex-encoded Ed25519 root CA public key. When set, enables PKI certificate mode (takes priority over `public_keys`). |
| `public_keys`           | `{}`                             | JSON object mapping `source` (device ID) to its hex-encoded Ed25519 public key. Used in static map mode. |
| `output_verified_topic` | `te/verified/events`             | Topic for messages with a valid signature. Set to empty string to silently discard.                       |
| `output_rejected_topic` | `te/rejected/events`             | Topic for messages with a missing or invalid signature. Set to empty string to silently discard.          |
| `debug`                 | `false`                          | When `true`, logs verification results to the console.                                                    |

### Static map mode setup

For each device running **tedge-events-signed**, extract its public key:

```sh
openssl pkey -in private.pem -pubout -outform DER | tail -c 32 | xxd -p -c 32
```

Then add it to `params.toml`:

```toml
public_keys = '{"my-device-001":"<hex-public-key>","my-device-002":"<hex-public-key>"}'
```

The `source` value in the payload (populated from `device.id` by the **tedge-config-context** flow) is used as the lookup key.

### Related flows

- **tedge-events-signed** — produces the signed events consumed by this flow.
- **x509-cert-issuer** — MQTT-based X.509 CA; issued `cert_der` can be used directly as `device_cert` in the signer.
- **tedge-config-context** — populates `device.id` in the shared mapper context used as the event `source`.
