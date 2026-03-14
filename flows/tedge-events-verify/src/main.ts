import { Message, Context, decodeJsonPayload } from "../../common/tedge";
import { ed25519 } from "@noble/curves/ed25519.js";

export interface Config {
  debug?: boolean;
  /**
   * Hex-encoded Ed25519 root CA public key.
   * When set, uses PKI certificate mode: messages must carry a `_cert` field
   * (a base64-encoded certificate JSON signed by the root CA), from which the
   * device's public key is extracted to verify the payload signature.
   */
  root_ca_public_key?: string;
  /**
   * JSON object mapping device source IDs to their hex-encoded Ed25519 public keys.
   * Used when root_ca_public_key is not set (static map mode).
   * Example: '{"my-device":"abc123...","other-device":"def456..."}'
   */
  public_keys?: string;
  /** Topic to forward verified messages to. Empty string discards them. */
  output_verified_topic?: string;
  /** Topic to forward rejected messages to. Empty string discards them. */
  output_rejected_topic?: string;
}

export interface FlowContext extends Context {
  config: Config;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// base64 decode without relying on atob global (not available in QuickJS)
function atobBytes(base64: string): Uint8Array {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = base64.replace(/=+$/, "");
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let byteIndex = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const b0 = chars.indexOf(clean[i]);
    const b1 = chars.indexOf(clean[i + 1]);
    const b2 = i + 2 < clean.length ? chars.indexOf(clean[i + 2]) : 0;
    const b3 = i + 3 < clean.length ? chars.indexOf(clean[i + 3]) : 0;
    bytes[byteIndex++] = (b0 << 2) | (b1 >> 4);
    if (i + 2 < clean.length) bytes[byteIndex++] = ((b1 & 15) << 4) | (b2 >> 2);
    if (i + 3 < clean.length) bytes[byteIndex++] = ((b2 & 3) << 6) | b3;
  }
  return bytes.slice(0, byteIndex);
}

function atobToString(base64: string): string {
  return new TextDecoder().decode(atobBytes(base64));
}

function verifyPayload(
  payload: Record<string, unknown>,
  sig: string,
  publicKeyHex: string,
): boolean {
  try {
    // exclude both signature fields from the verified canonical form
    const { _sig: _removed, _cert: _removedCert, ...rest } = payload;
    const encoder = new TextEncoder();
    const canonical = JSON.stringify(rest, Object.keys(rest).sort());
    return ed25519.verify(atobBytes(sig), encoder.encode(canonical), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

export function onMessage(message: Message, context: FlowContext) {
  const {
    debug = false,
    root_ca_public_key,
    public_keys: publicKeysJson = "{}",
    output_verified_topic = "te/verified/events",
    output_rejected_topic = "te/rejected/events",
  } = context.config;

  const payload = decodeJsonPayload(message.payload);

  if (debug) {
    console.log("Verifying message", { topic: message.topic, payload });
  }

  const { _sig, _cert, source } = payload;

  const reject = () =>
    output_rejected_topic
      ? [{ topic: output_rejected_topic, payload: message.payload }]
      : [];
  const accept = () =>
    output_verified_topic
      ? [{ topic: output_verified_topic, payload: message.payload }]
      : [];

  // no signature — reject immediately
  if (!_sig) {
    if (debug) console.log("No _sig field, rejecting");
    return reject();
  }

  if (root_ca_public_key) {
    // PKI mode: verify device certificate signed by root CA, then verify payload
    if (!_cert) {
      if (debug) console.log("PKI mode: no _cert field, rejecting");
      return reject();
    }

    let cert: Record<string, string>;
    try {
      cert = JSON.parse(atobToString(_cert as string));
    } catch {
      console.error("Failed to decode _cert");
      return reject();
    }

    const { _cert_sig, ...certBody } = cert;
    if (!_cert_sig) {
      console.error("Certificate missing _cert_sig");
      return reject();
    }

    try {
      const encoder = new TextEncoder();
      const certCanonical = JSON.stringify(certBody, Object.keys(certBody).sort());
      const certValid = ed25519.verify(
        atobBytes(_cert_sig),
        encoder.encode(certCanonical),
        hexToBytes(root_ca_public_key),
      );
      if (!certValid) {
        console.error("Certificate signature invalid");
        return reject();
      }
    } catch {
      console.error("Certificate verification error");
      return reject();
    }

    // check certificate expiry
    if (cert.expires && new Date(cert.expires) < new Date()) {
      console.error(`Certificate expired: ${cert.expires}`);
      return reject();
    }

    const valid = verifyPayload(payload, _sig as string, cert.public_key);
    if (debug) {
      console.log(
        `PKI: payload signature ${valid ? "valid" : "INVALID"} for device: ${cert.device_id}`,
      );
    }
    return valid ? accept() : reject();
  }

  // static map mode: look up device's public key by source field
  let publicKeys: Record<string, string>;
  try {
    publicKeys = JSON.parse(publicKeysJson);
  } catch {
    console.error("Invalid public_keys config: must be a JSON object");
    return [];
  }

  const publicKeyHex = publicKeys[source];
  if (!publicKeyHex) {
    console.error(`No public key registered for source: "${source}"`);
    return reject();
  }

  const valid = verifyPayload(payload, _sig as string, publicKeyHex);
  if (debug) {
    console.log(`Signature ${valid ? "valid" : "INVALID"} for source: ${source}`);
  }
  return valid ? accept() : reject();
}

