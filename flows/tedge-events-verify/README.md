## tedge-events-verify

Verify Ed25519 signatures on events produced by the **tedge-events-signed** flow.

### Description

The flow subscribes to the signed events topic and validates the `_sig` field in each message. Messages with a valid signature are forwarded to `output_verified_topic`. Messages with a missing, invalid, or unrecognised signature are forwarded to `output_rejected_topic` (useful for alerting or auditing).

Two verification modes are supported:

- **Static map mode** — each device's public key is pre-registered in the `public_keys` config parameter. Simpler to set up, suitable for smaller fleets.
- **PKI certificate mode** — a single root CA public key is configured. Each message carries a `_cert` field (a device certificate issued by the root CA), from which the device's public key is extracted at verify time. No per-device platform config is needed.

### Signature verification

The signature covers a canonical JSON representation of the payload — all fields except `_sig` and `_cert`, with keys sorted alphabetically and no extra whitespace. This matches the canonicalisation used by **tedge-events-signed**.

### PKI certificate mode

When `root_ca_public_key` is set, the verifier performs a two-step check:

1. Decode the `_cert` field (base64 → JSON) and verify its `_cert_sig` against the root CA public key.
2. Extract the device's `public_key` from the certificate and verify the payload's `_sig`.

Optionally, certificates can include an `expires` field (ISO 8601). Expired certificates are rejected.

To use PKI mode, configure the signer flow with a `device_cert` (see **tedge-events-signed** README for how to generate one) and set `root_ca_public_key` in this flow's `params.toml`:

```toml
root_ca_public_key = "<hex-root-ca-public-key>"
```

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
- **tedge-config-context** — populates `device.id` in the shared mapper context used as the event `source`.
