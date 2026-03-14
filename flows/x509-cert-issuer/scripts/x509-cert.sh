#!/usr/bin/env bash
# Helper script for the x509-cert-issuer flow.
# Requires: openssl (Ed25519 support), jq, xxd
#
# Commands:
#   setup-ca             Generate CA + factory CA and write params.toml (one-time)
#   create-factory-cert  Build a per-device factory certificate (Phase 1, manufacturer)
#   create-csr           Build and sign a CSR request (Phase 2, device first boot)
#   create-keygen-req    Build a signed keygen request (for constrained devices)
#   enroll               Full enrollment over MQTT: send request, wait for cert, save files
#   decode-cert          Decode and display an issued X.509 certificate (base64 DER)

set -euo pipefail

COMMAND="${1:-}"

usage() {
  cat <<'EOF'
Usage:
  x509-cert.sh setup-ca             [output-prefix]
  x509-cert.sh create-factory-cert  <device-id> <factory-ca-private.pem> [factory-device-private.pem]
  x509-cert.sh create-csr           <device-id> <factory-device-private.pem> <factory-cert-base64> [op-private.pem]
  x509-cert.sh create-keygen-req    <device-id> <factory-device-private.pem> <factory-cert-base64>
  x509-cert.sh enroll               <device-id> --broker <host> [options]
  x509-cert.sh decode-cert          <base64-DER-cert>

setup-ca
  Generates a CA key pair + self-signed certificate and a factory CA key pair,
  then writes a ready-to-use params.toml in the current directory. Run once.

  [output-prefix]   Filename prefix for CA files (default: x509-ca)

  Outputs:
    <prefix>-private.pem     CA private key (keep secret)
    <prefix>-cert.pem        CA certificate (install on MQTT broker as trusted CA)
    factory-ca-private.pem   Factory CA private key (used to sign per-device factory certs)
    params.toml              Flow configuration — copy to the flow working directory

  Example:
    ./x509-cert.sh setup-ca my-ca

create-factory-cert
  Builds a base64-encoded factory certificate for a specific device. Run once per device
  at manufacturing time. The cert and factory private key must both be stored on the device.

  <device-id>                    Device identifier
  <factory-ca-private.pem>       Factory CA private key (from setup-ca)
  [factory-device-private.pem]   Device factory private key (generated if not supplied,
                                  written to factory-device-private.pem in cwd)

  Outputs the factory certificate (base64) to stdout. Informational messages go to stderr.

  Example:
    FACTORY_CERT=$(./x509-cert.sh create-factory-cert my-device-001 factory-ca-private.pem 2>/dev/null)

create-csr
  Builds and signs a certificate signing request. Run at first boot on the device.
  Outputs a JSON payload to stdout — pipe it to mosquitto_pub or tedge flows test.

  <device-id>                    Device identifier (must match the factory cert)
  <factory-device-private.pem>   Device factory private key
  <factory-cert-base64>          Factory certificate (from create-factory-cert)
  [op-private.pem]               Operational private key (generated if not supplied,
                                  written to op-private.pem in cwd)

  Example:
    # Via MQTT broker:
    FACTORY_CERT=$(./x509-cert.sh create-factory-cert my-device-001 factory-ca-private.pem 2>/dev/null)
    ./x509-cert.sh create-csr my-device-001 factory-device-private.pem "$FACTORY_CERT" \
      | mosquitto_pub -h localhost -t te/pki/x509/csr -s

    # Local test with tedge flows test:
    REQUEST=$(./x509-cert.sh create-csr my-device-001 factory-device-private.pem "$FACTORY_CERT")
    echo "[te/pki/x509/csr] $REQUEST" \
      | tedge flows test --flow ./flow.toml \
      | sed 's/^\[.*\] //' \
      | jq -r '.cert_der' \
      | ./x509-cert.sh decode-cert -

create-keygen-req
  Builds a keygen request for devices that cannot produce a secure keypair.
  The flow generates the Ed25519 keypair and returns it with the signed certificate.
  Outputs a JSON payload to stdout.

  <device-id>                    Device identifier (must match the factory cert)
  <factory-device-private.pem>   Device factory private key
  <factory-cert-base64>          Factory certificate (from create-factory-cert)

  Example:
    ./x509-cert.sh create-keygen-req my-device-001 factory-device-private.pem "$FACTORY_CERT" \
      | mosquitto_pub -h localhost -t te/pki/x509/keygen -s

decode-cert
  Decodes and displays an issued X.509 certificate from base64 DER format.
  Accepts the base64 DER value as an argument or reads from stdin when '-' is given.

  <base64-DER-cert>   cert_der value from the flow response (or '-' to read from stdin)

  Example:
    ./x509-cert.sh decode-cert "$CERT_DER"
    echo "$CERT_DER" | ./x509-cert.sh decode-cert -

enroll
  Full first-boot enrollment over a live MQTT broker. Sends the certificate request,
  waits for the signed response, and writes the private key and certificates to disk.
  Requires: openssl, jq, xxd, mosquitto_pub, mosquitto_sub

  <device-id>                    Device identifier
  --broker <host>                MQTT broker hostname or IP (required)
  --port <port>                  MQTT broker port (default: 1883)
  --factory-cert <base64>        Factory certificate (required when require_factory_cert=true)
  --factory-key <pem>            Factory private key PEM (required when --factory-cert is set)
  --keygen                       Server generates the keypair (omit to supply your own)
  --op-key <pem>                 Existing operational private key PEM (CSR mode; generated if absent)
  --out-dir <dir>                Directory to write output files (default: .)
  --timeout <seconds>            How long to wait for the response (default: 30)
  --csr-topic <topic>            CSR topic (default: te/pki/x509/csr)
  --keygen-topic <topic>         Keygen topic (default: te/pki/x509/keygen)

  Output files written to --out-dir:
    device-private.pem   Private key (keygen mode or generated for CSR if --op-key not given)
    device-cert.pem      Issued TLS client certificate
    ca-cert.pem          CA certificate (install on broker as trusted CA)

  Examples:
    # Open mode (require_factory_cert=false), server generates keypair:
    ./x509-cert.sh enroll child-001 --broker mqtt.local --keygen

    # Factory cert mode, device supplies its own keypair:
    FACTORY_CERT=\$(./x509-cert.sh create-factory-cert child-001 factory-ca-private.pem 2>/dev/null)
    ./x509-cert.sh enroll child-001 --broker mqtt.local \
      --factory-cert "\$FACTORY_CERT" --factory-key factory-device-private.pem

    # Factory cert mode, server generates keypair:
    ./x509-cert.sh enroll child-001 --broker mqtt.local --keygen \
      --factory-cert "\$FACTORY_CERT" --factory-key factory-device-private.pem

Full workflow:
  # 1. One-time: generate CA + factory CA, write params.toml
  ./x509-cert.sh setup-ca my-ca

  # 2. Per device (Phase 1, manufacturer): create factory certificate
  FACTORY_CERT=$(./x509-cert.sh create-factory-cert my-device-001 factory-ca-private.pem 2>/dev/null)

  # 3. First boot (Phase 2): enroll over MQTT
  FACTORY_CERT=$(./x509-cert.sh create-factory-cert my-device-001 factory-ca-private.pem 2>/dev/null)
  ./x509-cert.sh enroll my-device-001 --broker mqtt.local --keygen \
    --factory-cert "$FACTORY_CERT" --factory-key factory-device-private.pem
  # => writes device-private.pem, device-cert.pem, ca-cert.pem
EOF
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Error: '$1' is required but not found" >&2; exit 1; }
}

require_cmd openssl
require_cmd jq
require_cmd xxd
# ─── enroll helpers ──────────────────────────────────────────────────────────

# Parse --key value pairs from remaining args into variables.
# Usage: parse_flags "$@"; then access $FLAG_BROKER etc.
parse_enroll_flags() {
  ENROLL_BROKER=""
  ENROLL_PORT="2883"
  ENROLL_FACTORY_CERT=""
  ENROLL_FACTORY_KEY=""
  ENROLL_KEYGEN=false
  ENROLL_OP_KEY=""
  ENROLL_OUT_DIR="."
  ENROLL_TIMEOUT="30"
  ENROLL_CSR_TOPIC="te/pki/x509/csr"
  ENROLL_KEYGEN_TOPIC="te/pki/x509/keygen"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --broker)        ENROLL_BROKER="$2";        shift 2 ;;
      --port)          ENROLL_PORT="$2";          shift 2 ;;
      --factory-cert)  ENROLL_FACTORY_CERT="$2";  shift 2 ;;
      --factory-key)   ENROLL_FACTORY_KEY="$2";   shift 2 ;;
      --keygen)        ENROLL_KEYGEN=true;         shift   ;;
      --op-key)        ENROLL_OP_KEY="$2";         shift 2 ;;
      --out-dir)       ENROLL_OUT_DIR="$2";        shift 2 ;;
      --timeout)       ENROLL_TIMEOUT="$2";        shift 2 ;;
      --csr-topic)     ENROLL_CSR_TOPIC="$2";      shift 2 ;;
      --keygen-topic)  ENROLL_KEYGEN_TOPIC="$2";   shift 2 ;;
      *) echo "Error: unknown flag '$1'" >&2; exit 1 ;;
    esac
  done
}
sign_file() {
  local priv_pem="$1"
  local data_file="$2"
  openssl pkeyutl -sign -inkey "$priv_pem" -rawin -in "$data_file" | base64 | tr -d '\n'
}

case "$COMMAND" in

  # ─── setup-ca ────────────────────────────────────────────────────────────────
  setup-ca)
    PREFIX="${2:-x509-ca}"
    CA_PRIV_PEM="${PREFIX}-private.pem"
    CA_CERT_PEM="${PREFIX}-cert.pem"
    FACTORY_CA_PRIV_PEM="factory-ca-private.pem"

    # Generate CA private key and self-signed certificate
    openssl genpkey -algorithm ed25519 -out "$CA_PRIV_PEM" 2>/dev/null
    openssl req -new -x509 -key "$CA_PRIV_PEM" -out "$CA_CERT_PEM" \
      -days 3650 -subj "/CN=${PREFIX}"

    # Generate factory CA private key (used to sign per-device factory certs)
    openssl genpkey -algorithm ed25519 -out "$FACTORY_CA_PRIV_PEM" 2>/dev/null

    # Extract hex/DER values for params.toml
    CA_PRIV_HEX=$(openssl pkey -in "$CA_PRIV_PEM" -outform DER | tail -c 32 | xxd -p -c 32)
    CA_CERT_DER=$(openssl x509 -in "$CA_CERT_PEM" -outform DER | base64 | tr -d '\n')
    FACTORY_CA_PUB=$(openssl pkey -in "$FACTORY_CA_PRIV_PEM" -pubout -outform DER \
      | tail -c 32 | xxd -p -c 32)

    # Write params.toml
    cat > params.toml <<EOF
ca_private_key = "$CA_PRIV_HEX"
ca_cert_der = "$CA_CERT_DER"
factory_ca_public_keys = "[\"$FACTORY_CA_PUB\"]"
require_factory_cert = true
cert_validity_days = 365
EOF

    echo "CA setup complete:" >&2
    echo "  $CA_PRIV_PEM    — keep secret" >&2
    echo "  $CA_CERT_PEM    — install on MQTT broker as trusted CA" >&2
    echo "  $FACTORY_CA_PRIV_PEM — keep secret, used to create per-device factory certs" >&2
    echo "  params.toml             — copy to the flow working directory" >&2
    echo "" >&2
    echo "Next step: create a factory cert for each device:" >&2
    echo "  FACTORY_CERT=\$(./x509-cert.sh create-factory-cert <device-id> $FACTORY_CA_PRIV_PEM 2>/dev/null)" >&2
    ;;

  # ─── create-factory-cert ─────────────────────────────────────────────────────
  create-factory-cert)
    DEVICE_ID="${2:?'device-id required'}"
    FACTORY_CA_PRIV_PEM="${3:?'factory-ca-private.pem required'}"
    FACTORY_DEV_PEM="${4:-factory-device-private.pem}"

    [[ -f "$FACTORY_CA_PRIV_PEM" ]] || { echo "Error: $FACTORY_CA_PRIV_PEM not found" >&2; exit 1; }

    # Generate per-device factory keypair if not supplied
    if [[ ! -f "$FACTORY_DEV_PEM" ]]; then
      openssl genpkey -algorithm ed25519 -out "$FACTORY_DEV_PEM" 2>/dev/null
      echo "Generated factory device private key: $FACTORY_DEV_PEM" >&2
      echo "  → burn both this key and the factory certificate onto the device's secure storage" >&2
    fi

    # Extract device factory public key
    FACTORY_DEV_PUB=$(openssl pkey -in "$FACTORY_DEV_PEM" -pubout -outform DER \
      | tail -c 32 | xxd -p -c 32)

    # Build canonical cert body (keys sorted alphabetically: device_id, public_key)
    CERT_BODY=$(jq -cn \
      --arg id  "$DEVICE_ID" \
      --arg pub "$FACTORY_DEV_PUB" \
      '{device_id: $id, public_key: $pub} | to_entries | sort_by(.key) | from_entries')

    # Sign canonical body with factory CA
    TMP=$(mktemp)
    trap 'rm -f "$TMP"' EXIT
    printf '%s' "$CERT_BODY" > "$TMP"
    CERT_SIG=$(sign_file "$FACTORY_CA_PRIV_PEM" "$TMP")

    # Assemble and base64-encode the factory certificate (stdout)
    jq -cn \
      --argjson body "$CERT_BODY" \
      --arg     sig  "$CERT_SIG" \
      '$body + {_cert_sig: $sig}' \
      | base64 | tr -d '\n'
    ;;

  # ─── create-csr ──────────────────────────────────────────────────────────────
  create-csr)
    DEVICE_ID="${2:?'device-id required'}"
    FACTORY_DEV_PRIV="${3:?'factory-device-private.pem required'}"
    FACTORY_CERT_B64="${4:?'factory-cert-base64 required'}"
    OP_PEM="${5:-op-private.pem}"

    [[ -f "$FACTORY_DEV_PRIV" ]] || { echo "Error: $FACTORY_DEV_PRIV not found" >&2; exit 1; }

    # Generate operational keypair if not supplied
    if [[ ! -f "$OP_PEM" ]]; then
      openssl genpkey -algorithm ed25519 -out "$OP_PEM" 2>/dev/null
      echo "Generated operational private key: $OP_PEM" >&2
    fi

    # Extract operational public key
    OP_PUB=$(openssl pkey -in "$OP_PEM" -pubout -outform DER | tail -c 32 | xxd -p -c 32)

    # Random nonce
    NONCE=$(openssl rand -hex 16)

    # Build canonical request body (keys sorted: device_id, nonce, public_key)
    REQ_BODY=$(jq -cn \
      --arg id  "$DEVICE_ID" \
      --arg n   "$NONCE" \
      --arg pub "$OP_PUB" \
      '{device_id: $id, nonce: $n, public_key: $pub} | to_entries | sort_by(.key) | from_entries')

    # Sign with factory device private key
    TMP=$(mktemp)
    trap 'rm -f "$TMP"' EXIT
    printf '%s' "$REQ_BODY" > "$TMP"
    REQ_SIG=$(sign_file "$FACTORY_DEV_PRIV" "$TMP")

    # Output CSR JSON to stdout
    jq -cn \
      --arg id   "$DEVICE_ID" \
      --arg pub  "$OP_PUB" \
      --arg n    "$NONCE" \
      --arg cert "$FACTORY_CERT_B64" \
      --arg sig  "$REQ_SIG" \
      '{device_id: $id, public_key: $pub, nonce: $n, _factory_cert: $cert, _req_sig: $sig}'
    ;;

  # ─── create-keygen-req ───────────────────────────────────────────────────────
  create-keygen-req)
    DEVICE_ID="${2:?'device-id required'}"
    FACTORY_DEV_PRIV="${3:?'factory-device-private.pem required'}"
    FACTORY_CERT_B64="${4:?'factory-cert-base64 required'}"

    [[ -f "$FACTORY_DEV_PRIV" ]] || { echo "Error: $FACTORY_DEV_PRIV not found" >&2; exit 1; }

    # Random nonce
    NONCE=$(openssl rand -hex 16)

    # Build canonical request body (keys sorted: device_id, nonce) — no public_key
    REQ_BODY=$(jq -cn \
      --arg id "$DEVICE_ID" \
      --arg n  "$NONCE" \
      '{device_id: $id, nonce: $n} | to_entries | sort_by(.key) | from_entries')

    # Sign with factory device private key
    TMP=$(mktemp)
    trap 'rm -f "$TMP"' EXIT
    printf '%s' "$REQ_BODY" > "$TMP"
    REQ_SIG=$(sign_file "$FACTORY_DEV_PRIV" "$TMP")

    # Output keygen request JSON to stdout
    jq -cn \
      --arg id   "$DEVICE_ID" \
      --arg n    "$NONCE" \
      --arg cert "$FACTORY_CERT_B64" \
      --arg sig  "$REQ_SIG" \
      '{device_id: $id, nonce: $n, _factory_cert: $cert, _req_sig: $sig}'
    ;;

  # ─── enroll ──────────────────────────────────────────────────────────────────
  enroll)
    ENROLL_DEVICE_ID="${2:?'device-id required'}"
    shift 2
    parse_enroll_flags "$@"

    require_cmd mosquitto_pub
    require_cmd mosquitto_sub

    [[ -n "$ENROLL_BROKER" ]] || { echo "Error: --broker is required" >&2; exit 1; }
    mkdir -p "$ENROLL_OUT_DIR"

    NONCE=$(openssl rand -hex 16)
    RESPONSE_FILE=$(mktemp)
    trap 'rm -f "$RESPONSE_FILE"' EXIT

    if $ENROLL_KEYGEN; then
      # ── keygen mode: server generates the keypair ──
      TOPIC="$ENROLL_KEYGEN_TOPIC"
      ISSUED_TOPIC_PREFIX="te/pki/x509/keygen/issued"

      if [[ -n "$ENROLL_FACTORY_CERT" ]]; then
        [[ -n "$ENROLL_FACTORY_KEY" ]] || { echo "Error: --factory-key required when --factory-cert is set" >&2; exit 1; }
        [[ -f "$ENROLL_FACTORY_KEY" ]] || { echo "Error: $ENROLL_FACTORY_KEY not found" >&2; exit 1; }

        REQ_BODY=$(jq -cn \
          --arg id "$ENROLL_DEVICE_ID" --arg n "$NONCE" \
          '{device_id: $id, nonce: $n} | to_entries | sort_by(.key) | from_entries')
        TMP_BODY=$(mktemp); trap 'rm -f "$TMP_BODY" "$RESPONSE_FILE"' EXIT
        printf '%s' "$REQ_BODY" > "$TMP_BODY"
        REQ_SIG=$(sign_file "$ENROLL_FACTORY_KEY" "$TMP_BODY")

        PAYLOAD=$(jq -cn \
          --arg id   "$ENROLL_DEVICE_ID" \
          --arg n    "$NONCE" \
          --arg cert "$ENROLL_FACTORY_CERT" \
          --arg sig  "$REQ_SIG" \
          '{device_id: $id, nonce: $n, _factory_cert: $cert, _req_sig: $sig}')
      else
        PAYLOAD=$(jq -cn \
          --arg id "$ENROLL_DEVICE_ID" --arg n "$NONCE" \
          '{device_id: $id, nonce: $n}')
      fi
    else
      # ── CSR mode: device supplies its own public key ──
      TOPIC="$ENROLL_CSR_TOPIC"
      ISSUED_TOPIC_PREFIX="te/pki/x509/cert/issued"

      OP_KEY_FILE="${ENROLL_OP_KEY:-${ENROLL_OUT_DIR}/device-private.pem}"
      if [[ ! -f "$OP_KEY_FILE" ]]; then
        openssl genpkey -algorithm ed25519 -out "$OP_KEY_FILE" 2>/dev/null
        echo "Generated operational private key: $OP_KEY_FILE" >&2
      fi
      OP_PUB=$(openssl pkey -in "$OP_KEY_FILE" -pubout -outform DER | tail -c 32 | xxd -p -c 32)

      if [[ -n "$ENROLL_FACTORY_CERT" ]]; then
        [[ -n "$ENROLL_FACTORY_KEY" ]] || { echo "Error: --factory-key required when --factory-cert is set" >&2; exit 1; }
        [[ -f "$ENROLL_FACTORY_KEY" ]] || { echo "Error: $ENROLL_FACTORY_KEY not found" >&2; exit 1; }

        REQ_BODY=$(jq -cn \
          --arg id "$ENROLL_DEVICE_ID" --arg n "$NONCE" --arg pub "$OP_PUB" \
          '{device_id: $id, nonce: $n, public_key: $pub} | to_entries | sort_by(.key) | from_entries')
        TMP_BODY=$(mktemp); trap 'rm -f "$TMP_BODY" "$RESPONSE_FILE"' EXIT
        printf '%s' "$REQ_BODY" > "$TMP_BODY"
        REQ_SIG=$(sign_file "$ENROLL_FACTORY_KEY" "$TMP_BODY")

        PAYLOAD=$(jq -cn \
          --arg id   "$ENROLL_DEVICE_ID" \
          --arg pub  "$OP_PUB" \
          --arg n    "$NONCE" \
          --arg cert "$ENROLL_FACTORY_CERT" \
          --arg sig  "$REQ_SIG" \
          '{device_id: $id, public_key: $pub, nonce: $n, _factory_cert: $cert, _req_sig: $sig}')
      else
        PAYLOAD=$(jq -cn \
          --arg id "$ENROLL_DEVICE_ID" --arg pub "$OP_PUB" --arg n "$NONCE" \
          '{device_id: $id, public_key: $pub, nonce: $n}')
      fi
    fi

    # Subscribe for the response before publishing (avoid race)
    RESPONSE_TOPIC="${ISSUED_TOPIC_PREFIX}/${ENROLL_DEVICE_ID}"
    echo "Subscribing to $RESPONSE_TOPIC ..." >&2
    mosquitto_sub \
      -h "$ENROLL_BROKER" -p "$ENROLL_PORT" \
      -t "$RESPONSE_TOPIC" \
      -C 1 -W "$ENROLL_TIMEOUT" > "$RESPONSE_FILE" &
    SUB_PID=$!

    # Small delay to ensure the subscription is active before publishing
    sleep 0.3

    echo "Publishing enrollment request to $TOPIC ..." >&2
    printf '%s' "$PAYLOAD" | mosquitto_pub \
      -h "$ENROLL_BROKER" -p "$ENROLL_PORT" \
      -t "$TOPIC" -s

    wait "$SUB_PID" || { echo "Error: timed out waiting for response on $RESPONSE_TOPIC" >&2; exit 1; }

    # Validate response
    CERT_DER=$(jq -r '.cert_der    // empty' "$RESPONSE_FILE")
    CA_DER=$(jq   -r '.ca_cert_der // empty' "$RESPONSE_FILE")
    [[ -n "$CERT_DER" ]] || { echo "Error: response missing cert_der — $(cat "$RESPONSE_FILE")" >&2; exit 1; }

    # Write certificate and CA cert
    printf '%s' "$CERT_DER" | base64 -d | openssl x509 -inform DER -out "${ENROLL_OUT_DIR}/device-cert.pem"
    printf '%s' "$CA_DER"   | base64 -d | openssl x509 -inform DER -out "${ENROLL_OUT_DIR}/ca-cert.pem"

    # Write private key (keygen only — CSR mode key was already written above)
    if $ENROLL_KEYGEN; then
      PRIV_DER=$(jq -r '.private_key_der // empty' "$RESPONSE_FILE")
      [[ -n "$PRIV_DER" ]] || { echo "Error: response missing private_key_der" >&2; exit 1; }
      printf '%s' "$PRIV_DER" | base64 -d | openssl pkey -inform DER -out "${ENROLL_OUT_DIR}/device-private.pem"
    fi

    echo "Enrollment complete. Files written to ${ENROLL_OUT_DIR}/" >&2
    echo "  device-private.pem  — private key (keep secret)" >&2
    echo "  device-cert.pem     — TLS client certificate" >&2
    echo "  ca-cert.pem         — CA certificate (install on broker as trusted CA)" >&2
    openssl verify -CAfile "${ENROLL_OUT_DIR}/ca-cert.pem" "${ENROLL_OUT_DIR}/device-cert.pem" >&2
    ;;

  # ─── decode-cert ─────────────────────────────────────────────────────────────
  decode-cert)
    CERT_B64="${2:--}"  # '-' means read from stdin

    if [[ "$CERT_B64" == "-" ]]; then
      # Read and strip any newlines from stdin
      CERT_B64=$(cat | tr -d '\n')
    fi

    [[ -n "$CERT_B64" ]] || { echo "Error: no certificate data provided" >&2; exit 1; }

    printf '%s' "$CERT_B64" | base64 -d | openssl x509 -inform DER -text -noout
    ;;

  *)
    usage
    ;;
esac
