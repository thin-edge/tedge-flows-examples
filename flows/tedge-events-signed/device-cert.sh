#!/usr/bin/env bash
# Manage device certificates for the tedge-events-signed PKI flow.
# Requires: openssl, jq, xxd
#
# Commands:
#   create-ca  Generate a root CA key pair
#   create     Create a device certificate signed by the root CA
#   verify     Verify a device certificate against the root CA public key

set -euo pipefail

COMMAND="${1:-}"

usage() {
  cat <<'EOF'
Usage:
  device-cert.sh create-ca <output-prefix>
  device-cert.sh create    <device-id> <device-private.pem> <ca-private.pem> [expires]
  device-cert.sh verify    <cert-base64> <ca-public.pem>

create-ca
  Generates a root CA Ed25519 key pair. Writes two files:
    <output-prefix>-private.pem  Root CA private key (keep offline)
    <output-prefix>-public.pem   Root CA public key (configure in verifier as root_ca_public_key)
  Also prints the hex-encoded public key to stdout.

  <output-prefix>  Filename prefix, e.g. "ca" produces ca-private.pem and ca-public.pem

create
  Generates a device certificate for use with the tedge-events-signed flow.
  Outputs the base64-encoded certificate to stdout — paste it into params.toml as device_cert.

  <device-id>          Identifier for the device (matches device.id / source field)
  <device-private.pem> Device Ed25519 private key in PEM format
  <ca-private.pem>     Root CA private key used to sign the certificate
  [expires]            Optional ISO 8601 expiry timestamp (e.g. 2027-01-01T00:00:00Z)

verify
  Decodes and verifies a device certificate against the root CA public key.

  <cert-base64>   Base64-encoded device certificate (value of device_cert in params.toml)
  <ca-public.pem> Root CA public key in PEM format

Examples:
  # One-time setup: generate root CA
  ./device-cert.sh create-ca ca

  # Per-device: generate key pair, create cert, verify it
  openssl genpkey -algorithm ed25519 -out device-private.pem
  ./device-cert.sh create my-device device-private.pem ca-private.pem 2027-01-01T00:00:00Z
  ./device-cert.sh verify "eyJkZXZpY2VfaWQiOi..." ca-public.pem
EOF
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Error: '$1' is required but not found" >&2; exit 1; }
}

require_cmd openssl
require_cmd jq
require_cmd xxd

case "$COMMAND" in
  create-ca)
    PREFIX="${2:?'output-prefix required'}"

    PRIV="${PREFIX}-private.pem"
    PUB="${PREFIX}-public.pem"

    openssl genpkey -algorithm ed25519 -out "$PRIV" 2>/dev/null
    openssl pkey -in "$PRIV" -pubout -out "$PUB" 2>/dev/null

    HEX=$(openssl pkey -in "$PRIV" -pubout -outform DER | tail -c 32 | xxd -p -c 32)

    echo "Root CA key pair written:"
    echo "  private: $PRIV  (keep offline)"
    echo "  public : $PUB"
    echo ""
    echo "root_ca_public_key (hex) — configure this in the verifier's params.toml:"
    echo "$HEX"
    ;;

  create)
    DEVICE_ID="${2:?'device-id required'}"
    DEVICE_PEM="${3:?'device-private.pem required'}"
    CA_PEM="${4:?'ca-private.pem required'}"
    EXPIRES="${5:-}"

    if [[ ! -f "$DEVICE_PEM" ]]; then
      openssl genpkey -algorithm ed25519 -out "$DEVICE_PEM" 2>/dev/null
      echo "Generated device private key: $DEVICE_PEM" >&2
      DEVICE_PRIVKEY_HEX=$(openssl pkey -in "$DEVICE_PEM" -outform DER | tail -c 32 | xxd -p -c 32)
      echo "private_key (hex) — put this in params.toml:" >&2
      echo "$DEVICE_PRIVKEY_HEX" >&2
    fi
    [[ -f "$CA_PEM" ]] || { echo "Error: $CA_PEM not found" >&2; exit 1; }

    # Extract device public key as hex
    DEVICE_PUBKEY=$(openssl pkey -in "$DEVICE_PEM" -pubout -outform DER | tail -c 32 | xxd -p -c 32)

    # Build canonical cert body (keys in alphabetical order: device_id, [expires,] public_key)
    if [[ -n "$EXPIRES" ]]; then
      CERT_BODY=$(jq -cn \
        --arg id  "$DEVICE_ID" \
        --arg exp "$EXPIRES" \
        --arg pub "$DEVICE_PUBKEY" \
        '{device_id: $id, expires: $exp, public_key: $pub}')
    else
      CERT_BODY=$(jq -cn \
        --arg id  "$DEVICE_ID" \
        --arg pub "$DEVICE_PUBKEY" \
        '{device_id: $id, public_key: $pub}')
    fi

    # openssl pkeyutl -rawin requires a file (cannot read from stdin)
    TMP_BODY=$(mktemp)
    trap 'rm -f "$TMP_BODY"' EXIT
    printf '%s' "$CERT_BODY" > "$TMP_BODY"

    CERT_SIG=$(openssl pkeyutl -sign -inkey "$CA_PEM" -rawin -in "$TMP_BODY" | base64 | tr -d '\n')

    # Assemble final cert and base64-encode it for params.toml
    DEVICE_CERT=$(jq -cn --argjson body "$CERT_BODY" --arg sig "$CERT_SIG" '$body + {_cert_sig: $sig}' \
      | base64 | tr -d '\n')

    echo "Certificate created for device: $DEVICE_ID" >&2
    echo "" >&2
    echo "Add the following to params.toml on the device:" >&2
    echo "  device_cert = \"$DEVICE_CERT\"" >&2
    ;;

  verify)
    CERT_B64="${2:?'cert-base64 required'}"
    CA_PUB="${3:?'ca-public.pem required'}"

    [[ -f "$CA_PUB" ]] || { echo "Error: $CA_PUB not found" >&2; exit 1; }

    CERT_JSON=$(printf '%s' "$CERT_B64" | base64 -d)
    CERT_SIG=$(printf '%s' "$CERT_JSON" | jq -r '._cert_sig')
    # Rebuild canonical cert body: all fields except _cert_sig, sorted by key
    CERT_BODY=$(printf '%s' "$CERT_JSON" | jq -c 'del(._cert_sig) | to_entries | sort_by(.key) | from_entries')
    DEVICE_ID=$(printf '%s' "$CERT_JSON" | jq -r '.device_id')
    DEVICE_PUBKEY=$(printf '%s' "$CERT_JSON" | jq -r '.public_key')
    EXPIRES=$(printf '%s' "$CERT_JSON" | jq -r '.expires // "(none)"')

    TMP_BODY=$(mktemp)
    TMP_SIG=$(mktemp)
    trap 'rm -f "$TMP_BODY" "$TMP_SIG"' EXIT

    printf '%s' "$CERT_BODY" > "$TMP_BODY"
    printf '%s' "$CERT_SIG" | base64 -d > "$TMP_SIG"

    if openssl pkeyutl -verify -pubin -inkey "$CA_PUB" -rawin -in "$TMP_BODY" -sigfile "$TMP_SIG" 2>/dev/null; then
      echo "Certificate valid"
      echo "  device_id : $DEVICE_ID"
      echo "  public_key: $DEVICE_PUBKEY"
      echo "  expires   : $EXPIRES"
    else
      echo "Certificate verification FAILED" >&2
      exit 1
    fi
    ;;

  *)
    usage
    ;;
esac
