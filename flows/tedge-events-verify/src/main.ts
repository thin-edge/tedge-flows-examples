import { Message, Context, decodeJsonPayload } from "../../common/tedge";
import { ed25519 } from "@noble/curves/ed25519.js";
import * as asn1 from "asn1js";

export interface Config {
  debug?: boolean;
  /**
   * Hex-encoded Ed25519 root CA public key.
   * When set, uses PKI certificate mode: messages must carry a `_cert` field.
   * Two certificate formats are auto-detected by the first byte of the decoded bytes:
   *   - X.509 DER (0x30): standard certificate issued by x509-cert-issuer.
   *     Extract the CA public key with:
   *       openssl pkey -in ca.pem -pubout -outform DER | tail -c 32 | xxd -p -c 32
   *   - JSON (other): lightweight JSON cert issued by pki-issuer
   *     {device_id, public_key, expires, _cert_sig}.
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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toAB(arr: Uint8Array): ArrayBuffer {
  return (arr.buffer as ArrayBuffer).slice(
    arr.byteOffset,
    arr.byteOffset + arr.byteLength,
  );
}

function toU8(ab: ArrayBuffer): Uint8Array {
  return new Uint8Array(ab);
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

// ---------------------------------------------------------------------------
// X.509 DER certificate helpers (for certs issued by x509-cert-issuer)
// ---------------------------------------------------------------------------

/** Navigate TBSCertificate fields, skipping the optional [0] EXPLICIT version tag. */
function getTBSField(tbsFields: asn1.AsnType[], index: number): asn1.AsnType {
  const offset =
    tbsFields[0].idBlock.tagClass === 3 && tbsFields[0].idBlock.tagNumber === 0
      ? 1
      : 0;
  return tbsFields[offset + index];
}

/**
 * Parse an ASN.1 UTCTime or GeneralizedTime node to a JavaScript Date.
 * UTCTime string: "YYMMDDHHMMSSZ"  (13 chars)
 * GeneralizedTime: "YYYYMMDDHHMMSSZ" (15 chars)
 */
function parseASN1Time(node: asn1.AsnType): Date {
  const s = (node as any).valueBlock.value as string;
  if (s.length === 13) {
    // UTCTime
    const yy = parseInt(s.slice(0, 2), 10);
    return new Date(
      Date.UTC(
        yy >= 50 ? 1900 + yy : 2000 + yy,
        parseInt(s.slice(2, 4), 10) - 1,
        parseInt(s.slice(4, 6), 10),
        parseInt(s.slice(6, 8), 10),
        parseInt(s.slice(8, 10), 10),
        parseInt(s.slice(10, 12), 10),
      ),
    );
  }
  // GeneralizedTime
  return new Date(
    Date.UTC(
      parseInt(s.slice(0, 4), 10),
      parseInt(s.slice(4, 6), 10) - 1,
      parseInt(s.slice(6, 8), 10),
      parseInt(s.slice(8, 10), 10),
      parseInt(s.slice(10, 12), 10),
      parseInt(s.slice(12, 14), 10),
    ),
  );
}

/**
 * Verify an X.509 DER certificate's Ed25519 signature against a raw CA public key (hex).
 * The TBSCertificate bytes are the signed data; the outer BIT STRING holds the 64-byte signature.
 */
function verifyX509Cert(derBytes: Uint8Array, caPublicKeyHex: string): boolean {
  try {
    const parsed = asn1.fromBER(toAB(derBytes));
    if (parsed.offset === -1) return false;
    const certFields = (parsed.result as any).valueBlock
      .value as asn1.AsnType[];
    // TBS bytes are what was signed
    const tbsBytes = toU8(certFields[0].toBER(false));
    // Signature BIT STRING DER: [0x03, 0x41, 0x00, <64 bytes>] — take the last 64 bytes
    const sigBitStringDer = toU8(certFields[2].toBER(false));
    const sigBytes = sigBitStringDer.slice(-64);
    return ed25519.verify(sigBytes, tbsBytes, hexToBytes(caPublicKeyHex));
  } catch {
    return false;
  }
}

/**
 * Parse an X.509 DER certificate and extract the Ed25519 device public key (hex)
 * and the notAfter validity date. Returns null if the certificate cannot be parsed.
 *
 * Ed25519 SubjectPublicKeyInfo DER is always 44 bytes; the key is the last 32 bytes.
 */
function parseX509Cert(
  derBytes: Uint8Array,
): { publicKeyHex: string; notAfter: Date } | null {
  try {
    const parsed = asn1.fromBER(toAB(derBytes));
    if (parsed.offset === -1) return null;
    const certFields = (parsed.result as any).valueBlock
      .value as asn1.AsnType[];
    const tbsFields = (certFields[0] as any).valueBlock.value as asn1.AsnType[];

    // Validity (TBS field 3): second child is notAfter (UTCTime or GeneralizedTime)
    const validity = getTBSField(tbsFields, 3);
    const validityFields = (validity as any).valueBlock.value as asn1.AsnType[];
    const notAfter: Date = parseASN1Time(validityFields[1]);

    // SubjectPublicKeyInfo (TBS field 5): Ed25519 key is always the last 32 bytes of SPKI DER
    const spki = getTBSField(tbsFields, 5);
    const spkiDer = toU8(spki.toBER(false));
    const publicKeyHex = bytesToHex(spkiDer.slice(-32));

    return { publicKeyHex, notAfter };
  } catch {
    return null;
  }
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
    return ed25519.verify(
      atobBytes(sig),
      encoder.encode(canonical),
      hexToBytes(publicKeyHex),
    );
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

    const certBytes = atobBytes(_cert as string);

    if (certBytes[0] === 0x30) {
      // X.509 DER certificate (e.g. from x509-cert-issuer)
      if (!verifyX509Cert(certBytes, root_ca_public_key)) {
        console.error("X.509 certificate signature invalid");
        return reject();
      }
      const certInfo = parseX509Cert(certBytes);
      if (!certInfo) {
        console.error("Failed to parse X.509 certificate");
        return reject();
      }
      if (certInfo.notAfter < new Date()) {
        console.error(
          `X.509 certificate expired: ${certInfo.notAfter.toISOString()}`,
        );
        return reject();
      }
      const valid = verifyPayload(
        payload,
        _sig as string,
        certInfo.publicKeyHex,
      );
      if (debug) {
        console.log(
          `PKI X.509: payload signature ${valid ? "valid" : "INVALID"}`,
        );
      }
      return valid ? accept() : reject();
    }

    // JSON certificate (from pki-issuer): base64(JSON{device_id,public_key,expires,_cert_sig})
    let cert: Record<string, string>;
    try {
      cert = JSON.parse(new TextDecoder().decode(certBytes));
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
      const certCanonical = JSON.stringify(
        certBody,
        Object.keys(certBody).sort(),
      );
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
    console.log(
      `Signature ${valid ? "valid" : "INVALID"} for source: ${source}`,
    );
  }
  return valid ? accept() : reject();
}
