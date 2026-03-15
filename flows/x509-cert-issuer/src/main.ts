import {
  Message,
  Context,
  decodeJsonPayload,
  uint8ToBase64,
} from "../../common/tedge";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import * as asn1 from "asn1js";

export interface Config {
  /**
   * Base64-encoded 32-byte Ed25519 private key of this CA.
   * Generate with: openssl pkey -in ca.pem -outform DER | tail -c 32 | openssl base64 -A
   */
  ca_private_key?: string;
  /**
   * Base64-encoded DER of the CA certificate.
   * Generate with: openssl x509 -in ca.pem -outform DER | base64 | tr -d '\n'
   * This is included in the response so the device can install the full chain.
   */
  ca_cert_der?: string;
  /**
   * Certificate validity period in days.
   * Default: 365
   */
  cert_validity_days?: number;
  /**
   * Duration in hours within which each nonce is guaranteed to be unique.
   * Requests reusing a nonce within this window are rejected to prevent replay attacks.
   * Default: 24
   */
  nonce_window_hours?: number;
  /**
   * JSON array of trusted factory CA public keys (base64-encoded Ed25519).
   * A device must present a factory certificate signed by one of these CAs to
   * prove device identity before a certificate is issued.
   * Example: '["<base64-pubkey>", "<base64-pubkey>"]'
   */
  factory_ca_public_keys?: string[] | string;
  /**
   * Topic prefix for issued certificate responses.
   * The device_id is appended: <prefix>/<device_id>
   * Default: "te/pki/x509/cert/issued"
   */
  output_cert_topic_prefix?: string;
  /**
   * Topic for rejected requests.
   * Set to empty string to silently discard.
   * Default: "te/pki/x509/req/rejected"
   */
  output_rejected_topic?: string;
  /**
   * When false, factory certificate and request signature verification are skipped.
   * Only appropriate in isolated networks where the CSR/keygen topics are access-controlled.
   * Default: true
   */
  require_factory_cert?: boolean;
  /**
   * Input topic for server-side key generation requests.
   * The flow generates an Ed25519 keypair on behalf of the device and returns
   * the private key together with the signed certificate. Only use on private topics.
   * Default: "te/pki/x509/keygen"
   */
  keygen_topic?: string;
  /**
   * Topic prefix for keygen responses — device_id is appended: <prefix>/<device_id>
   * Default: "te/pki/x509/keygen/issued"
   */
  output_keygen_topic_prefix?: string;
  /**
   * Input topic for certificate renewal requests.
   * A device proves ownership of its current CA-issued certificate by signing the
   * renewal request with the corresponding private key (proof of possession).
   * No factory certificate is required.
   * Default: "te/pki/x509/renew"
   */
  renewal_topic?: string;
  /**
   * Topic prefix for renewal responses — device_id is appended: <prefix>/<device_id>.
   * Defaults to output_cert_topic_prefix when not set.
   */
  output_renewal_topic_prefix?: string;
  /**
   * When set, only allow renewals within this many days of certificate expiry.
   * Unset (default) means renewal is accepted at any time the certificate is still valid.
   */
  renewal_window_days?: number;
  /**
   * JSON array of device_id strings that are explicitly denied.
   * Matching requests are rejected regardless of factory certificate validity.
   * Default: []
   */
  denied_device_ids?: string[] | string;
  /**
   * JSON array of lowercase hex-encoded certificate serial numbers that are revoked.
   * This is the serial-number-based equivalent of a CRL (RFC 5280).
   * Checked against the serial in `_current_cert` for renewal requests —
   * blocking renewal of a specific compromised certificate without permanently
   * preventing the device from re-enrolling with a fresh factory certificate.
   * The serial is returned as `cert_serial` in every issuance response.
   * Default: []
   */
  revoked_cert_serials?: string[] | string;
  /**
   * JSON array of base64-encoded Ed25519 public keys of factory certificates
   * that have been compromised or should no longer be trusted for enrollment.
   * More targeted than denied_device_ids: it revokes a specific credential rather
   * than the device identity, so re-provisioning with a new factory certificate
   * (fresh burn) restores the device's ability to enroll.
   * Default: []
   */
  denied_factory_pubkeys?: string[] | string;
}

export interface FlowContext extends Context {
  config: Config;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

// Base64 decode without atob (not available in QuickJS)
function atobBytes(base64: string): Uint8Array {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = base64.replace(/\s/g, "").replace(/={1,2}$/, "");
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

function derToPem(label: string, der: Uint8Array): string {
  const b64 = uint8ToBase64(der);
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

/**
 * Cryptographically secure random bytes.
 * Uses crypto.getRandomValues when available (Node.js, modern browsers);
 * falls back to a Math.random()-based PRNG when running in constrained JS
 * environments (e.g. rquickjs). The fallback is suitable for serial numbers
 * but NOT for generating private keys in production.
 */
function safeRandomBytes(n: number): Uint8Array {
  if (
    typeof crypto !== "undefined" &&
    typeof (crypto as any).getRandomValues === "function"
  ) {
    return (crypto as any).getRandomValues(new Uint8Array(n));
  }
  // PRNG fallback — not cryptographically secure, only use for serial numbers
  const buf = new Uint8Array(n);
  let s0 = (Date.now() & 0xffffffff) ^ 0x5f3759df;
  let s1 = Math.floor(Math.random() * 0x100000000);
  for (let i = 0; i < n; i++) {
    if (i % 4 === 0) s1 ^= Math.floor(Math.random() * 0x100000000);
    s0 = (Math.imul(s0, 1664525) + 1013904223) >>> 0;
    s0 ^= s1;
    buf[i] = s0 & 0xff;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// ASN.1 / DER helpers using asn1js
// ---------------------------------------------------------------------------

/** Convert Uint8Array to ArrayBuffer (safe for sub-views). */
function toAB(arr: Uint8Array): ArrayBuffer {
  return (arr.buffer as ArrayBuffer).slice(
    arr.byteOffset,
    arr.byteOffset + arr.byteLength,
  );
}

/** Convert ArrayBuffer to Uint8Array. */
function toU8(ab: ArrayBuffer): Uint8Array {
  return new Uint8Array(ab);
}

// OID string constants
const OID_ED25519 = "1.3.101.112";
const OID_CN = "2.5.4.3";
const OID_SKI = "2.5.29.14";
const OID_AKI = "2.5.29.35";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_SAN = "2.5.29.17";

function algIdEd25519(): asn1.Sequence {
  return new asn1.Sequence({
    value: [new asn1.ObjectIdentifier({ value: OID_ED25519 })],
  });
}

function rdnName(cn: string): asn1.Sequence {
  return new asn1.Sequence({
    value: [
      new asn1.Set({
        value: [
          new asn1.Sequence({
            value: [
              new asn1.ObjectIdentifier({ value: OID_CN }),
              new asn1.Utf8String({ value: cn }),
            ],
          }),
        ],
      }),
    ],
  });
}

function asnSubjectPublicKeyInfo(pubKeyBytes: Uint8Array): asn1.Sequence {
  return new asn1.Sequence({
    value: [
      algIdEd25519(),
      new asn1.BitString({ valueHex: toAB(pubKeyBytes) }),
    ],
  });
}

/** SHA-256 of the raw public key bytes truncated to 160 bits (RFC 7093 Method 1). */
function keyIdentifier(pubKeyBytes: Uint8Array): Uint8Array {
  return sha256(pubKeyBytes).slice(0, 20);
}

/** Parse an IPv4 dotted-decimal string into 4 bytes, or null if invalid. */
function parseIPv4(ip: string): Uint8Array | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const n = parseInt(parts[i], 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

export interface SAN {
  /** DNS names to include as dNSName GeneralNames. */
  dns?: string[];
  /** IPv4 addresses to include as iPAddress GeneralNames. */
  ip?: string[];
}

function buildExtensions(
  subjectPubKey: Uint8Array,
  issuerPubKey: Uint8Array,
  isCA: boolean,
  issuerKeyId?: Uint8Array,
  san?: SAN,
): asn1.Constructed {
  const skiValue = keyIdentifier(subjectPubKey);
  // Use the CA cert's verbatim SKID bytes (extracted via readDerSKID) when available,
  // so that OpenSSL's AKI↔SKID comparison succeeds regardless of the CA's hash algorithm.
  const akiValue = issuerKeyId ?? keyIdentifier(issuerPubKey);

  // SKI extension: extnValue wraps OCTET STRING containing the key id
  const skiExt = new asn1.Sequence({
    value: [
      new asn1.ObjectIdentifier({ value: OID_SKI }),
      new asn1.OctetString({
        valueHex: new asn1.OctetString({ valueHex: toAB(skiValue) }).toBER(
          false,
        ),
      }),
    ],
  });

  // AKI extension: extnValue wraps SEQUENCE { [0] IMPLICIT keyIdentifier }
  const akiBody = new asn1.Sequence({
    value: [
      new asn1.Primitive({
        idBlock: { tagClass: 3, tagNumber: 0 },
        valueHex: toAB(akiValue),
      }),
    ],
  });
  const akiExt = new asn1.Sequence({
    value: [
      new asn1.ObjectIdentifier({ value: OID_AKI }),
      new asn1.OctetString({ valueHex: akiBody.toBER(false) }),
    ],
  });

  const exts: asn1.Sequence[] = [skiExt, akiExt];

  // SAN extension
  const dnsSANs = san?.dns?.filter(Boolean) ?? [];
  const ipSANs = san?.ip?.filter(Boolean) ?? [];
  if (dnsSANs.length > 0 || ipSANs.length > 0) {
    const generalNames: asn1.AsnType[] = [];
    for (const dns of dnsSANs) {
      generalNames.push(
        new asn1.Primitive({
          idBlock: { tagClass: 3, tagNumber: 2 }, // [2] dNSName IA5String
          valueHex: toAB(new TextEncoder().encode(dns)),
        }),
      );
    }
    for (const ip of ipSANs) {
      const ipBytes = parseIPv4(ip);
      if (ipBytes) {
        generalNames.push(
          new asn1.Primitive({
            idBlock: { tagClass: 3, tagNumber: 7 }, // [7] iPAddress OCTET STRING
            valueHex: toAB(ipBytes),
          }),
        );
      }
    }
    if (generalNames.length > 0) {
      const sanBody = new asn1.Sequence({ value: generalNames });
      exts.push(
        new asn1.Sequence({
          value: [
            new asn1.ObjectIdentifier({ value: OID_SAN }),
            new asn1.OctetString({ valueHex: sanBody.toBER(false) }),
          ],
        }),
      );
    }
  }

  if (isCA) {
    // BasicConstraints: critical=true, cA=true
    const bcBody = new asn1.Sequence({
      value: [
        new asn1.Boolean({ value: true }), // cA = TRUE
      ],
    });
    const bcExt = new asn1.Sequence({
      value: [
        new asn1.ObjectIdentifier({ value: OID_BASIC_CONSTRAINTS }),
        new asn1.Boolean({ value: true }), // critical
        new asn1.OctetString({ valueHex: bcBody.toBER(false) }),
      ],
    });
    exts.push(bcExt);
  }

  return new asn1.Constructed({
    idBlock: { tagClass: 3, tagNumber: 3 },
    value: [new asn1.Sequence({ value: exts })],
  });
}

/**
 * Build the DER TBSCertificate (the part that gets signed).
 */
function buildTBS(opts: {
  serialNumber: Uint8Array;
  /** Raw DER bytes of the issuer Name field (tag + length + value). */
  issuerNameDer: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  subjectCN: string;
  subjectPubKey: Uint8Array;
  issuerPubKey: Uint8Array;
  /** Verbatim SKID bytes extracted from the CA cert via readDerSKID(). Used as the AKI value. */
  issuerKeyId?: Uint8Array;
  isCA: boolean;
  /** Optional Subject Alternative Names to embed in the certificate. */
  san?: SAN;
}): Uint8Array {
  // version: [0] EXPLICIT INTEGER 2 (v3)
  const version = new asn1.Constructed({
    idBlock: { tagClass: 3, tagNumber: 0 },
    value: [new asn1.Integer({ value: 2 })],
  });
  const serial = new asn1.Integer({ valueHex: toAB(opts.serialNumber) });
  // Parse the issuer Name DER bytes back into an ASN.1 node to embed verbatim
  const issuerParsed = asn1.fromBER(toAB(opts.issuerNameDer));
  if (issuerParsed.offset === -1) {
    throw new Error("failed to parse issuer Name DER");
  }

  const tbs = new asn1.Sequence({
    value: [
      version,
      serial,
      algIdEd25519(),
      issuerParsed.result,
      new asn1.Sequence({
        value: [
          new asn1.UTCTime({ valueDate: opts.notBefore }),
          new asn1.UTCTime({ valueDate: opts.notAfter }),
        ],
      }),
      rdnName(opts.subjectCN),
      asnSubjectPublicKeyInfo(opts.subjectPubKey),
      buildExtensions(
        opts.subjectPubKey,
        opts.issuerPubKey,
        opts.isCA,
        opts.issuerKeyId,
        opts.san,
      ),
    ],
  });

  return toU8(tbs.toBER(false));
}

/**
 * Wrap a 32-byte Ed25519 private key seed in PKCS#8 DER (RFC 8410).
 */
function buildPrivKeyDER(privKeyBytes: Uint8Array): Uint8Array {
  const pkcs8 = new asn1.Sequence({
    value: [
      new asn1.Integer({ value: 0 }), // version
      algIdEd25519(),
      new asn1.OctetString({
        valueHex: new asn1.OctetString({ valueHex: toAB(privKeyBytes) }).toBER(
          false,
        ),
      }),
    ],
  });
  return toU8(pkcs8.toBER(false));
}

/**
 * Sign a TBSCertificate and wrap in a full Certificate DER.
 */
function signCert(tbs: Uint8Array, caPrivKeyB64: string): Uint8Array {
  const sig = ed25519.sign(tbs, atobBytes(caPrivKeyB64));
  const tbsParsed = asn1.fromBER(toAB(tbs));
  const cert = new asn1.Sequence({
    value: [
      tbsParsed.result,
      algIdEd25519(),
      new asn1.BitString({ valueHex: toAB(sig) }),
    ],
  });
  return toU8(cert.toBER(false));
}

// ---------------------------------------------------------------------------
// Factory certificate verification (same format as pki-issuer)
// ---------------------------------------------------------------------------

function verifyFactoryCert(
  factoryCertB64: string,
  deviceId: string,
  factoryCAPubKeys: string[],
):
  | { valid: false; reason: string }
  | { valid: true; factoryPubKeyB64: string } {
  let cert: Record<string, string>;
  try {
    cert = JSON.parse(atobToString(factoryCertB64));
  } catch {
    return { valid: false, reason: "invalid _factory_cert encoding" };
  }

  const { _cert_sig, ...certBody } = cert;
  if (!_cert_sig)
    return { valid: false, reason: "factory cert missing _cert_sig" };

  const encoder = new TextEncoder();
  const canonical = JSON.stringify(certBody, Object.keys(certBody).sort());

  const certValid = factoryCAPubKeys.some((caPubKey) => {
    try {
      return ed25519.verify(
        atobBytes(_cert_sig),
        encoder.encode(canonical),
        atobBytes(caPubKey),
      );
    } catch {
      return false;
    }
  });
  if (!certValid)
    return { valid: false, reason: "factory certificate signature invalid" };

  if (cert.device_id !== deviceId) {
    return {
      valid: false,
      reason: `device_id mismatch: factory cert has "${cert.device_id}", request has "${deviceId}"`,
    };
  }

  if (cert.expires && new Date(cert.expires) < new Date()) {
    return {
      valid: false,
      reason: `factory certificate expired: ${cert.expires}`,
    };
  }

  return { valid: true, factoryPubKeyB64: cert.public_key };
}

function verifyReqSig(
  deviceId: string,
  nonce: string,
  publicKey: string,
  reqSigB64: string,
  factoryPubKeyB64: string,
): boolean {
  try {
    const reqBody = { device_id: deviceId, nonce, public_key: publicKey };
    const encoder = new TextEncoder();
    const canonical = JSON.stringify(reqBody, Object.keys(reqBody).sort());
    return ed25519.verify(
      atobBytes(reqSigB64),
      encoder.encode(canonical),
      atobBytes(factoryPubKeyB64),
    );
  } catch {
    return false;
  }
}

/** Verify proof-of-possession for keygen requests (no public_key to include). */
function verifyKeygenReqSig(
  deviceId: string,
  nonce: string,
  reqSigB64: string,
  factoryPubKeyB64: string,
): boolean {
  try {
    const reqBody = { device_id: deviceId, nonce };
    const encoder = new TextEncoder();
    const canonical = JSON.stringify(reqBody, Object.keys(reqBody).sort());
    return ed25519.verify(
      atobBytes(reqSigB64),
      encoder.encode(canonical),
      atobBytes(factoryPubKeyB64),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// DER certificate parsing using asn1js
// ---------------------------------------------------------------------------

/**
 * Navigate a parsed TBSCertificate and return the child at the given field index
 * after accounting for the optional [0] version tag.
 *
 * TBS fields: version? | serial | sigAlg | issuer | validity | subject | SPKI | extensions?
 * Indices:     (skip)     0        1        2        3          4        5       6
 */
function getTBSField(
  certDer: Uint8Array,
  fieldIndex: number,
): asn1.AsnType | null {
  try {
    const parsed = asn1.fromBER(toAB(certDer));
    if (parsed.offset === -1) return null;
    const cert = parsed.result as asn1.Sequence;
    const tbs = (cert as any).valueBlock.value[0] as asn1.Sequence;
    const fields = (tbs as any).valueBlock.value as asn1.AsnType[];
    let idx = 0;
    // Skip optional [0] version
    if (fields[0].idBlock.tagClass === 3 && fields[0].idBlock.tagNumber === 0) {
      idx++;
    }
    return fields[idx + fieldIndex] ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract the raw subject Name DER bytes from a certificate.
 * Embedding these verbatim as the issuer field in a child certificate
 * guarantees byte-for-byte identity, which is required for OpenSSL's
 * chain builder to match names during verification.
 */
function readDerSubjectBytes(der: Uint8Array): Uint8Array | null {
  const subject = getTBSField(der, 4); // subject is field index 4
  if (!subject) return null;
  return toU8(subject.toBER(false));
}

/**
 * Extract the Subject Key Identifier value bytes from a DER-encoded certificate.
 *
 * The SKID bytes are copied verbatim as the AKI in issued certificates so that
 * OpenSSL's chain builder can match them (it compares AKI↔SKID bytes directly).
 */
function readDerSKID(der: Uint8Array): Uint8Array | null {
  try {
    const parsed = asn1.fromBER(toAB(der));
    if (parsed.offset === -1) return null;
    const cert = parsed.result as asn1.Sequence;
    const tbs = (cert as any).valueBlock.value[0] as asn1.Sequence;
    const fields = (tbs as any).valueBlock.value as asn1.AsnType[];
    // Find the [3] EXPLICIT extensions wrapper
    const extsWrapper = fields.find(
      (f: asn1.AsnType) =>
        f.idBlock.tagClass === 3 && f.idBlock.tagNumber === 3,
    ) as asn1.Constructed | undefined;
    if (!extsWrapper) return null;

    const extsSeq = (extsWrapper as any).valueBlock.value[0] as asn1.Sequence;
    const extensions = (extsSeq as any).valueBlock.value as asn1.Sequence[];

    for (const ext of extensions) {
      const extFields = (ext as any).valueBlock.value as asn1.AsnType[];
      const oid = extFields[0] as asn1.ObjectIdentifier;
      if (oid.valueBlock.toString() !== OID_SKI) continue;
      // The last field is the extnValue OCTET STRING
      const extnValue = extFields[extFields.length - 1] as asn1.OctetString;
      // Parse the inner OCTET STRING (SubjectKeyIdentifier ::= OCTET STRING)
      const inner = asn1.fromBER(extnValue.valueBlock.valueHexView);
      if (inner.offset === -1) return null;
      const innerOctet = inner.result as asn1.OctetString;
      const view = innerOctet.valueBlock.valueHexView;
      return toU8(
        (view.buffer as ArrayBuffer).slice(
          view.byteOffset,
          view.byteOffset + view.byteLength,
        ),
      );
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Certificate renewal helpers — parsing an existing DER-encoded certificate
// ---------------------------------------------------------------------------

/**
 * Extract the raw 32-byte Ed25519 public key from a DER-encoded certificate.
 * For Ed25519, the SPKI DER always ends with the 32-byte public key.
 */
function readCertPublicKeyBytes(der: Uint8Array): Uint8Array | null {
  const spki = getTBSField(der, 5); // SPKI is TBS field 5
  if (!spki) return null;
  try {
    const spkiDer = toU8(spki.toBER(false));
    if (spkiDer.length < 32) return null;
    return spkiDer.slice(-32);
  } catch {
    return null;
  }
}

/**
 * Verify that a DER-encoded certificate was signed by the given Ed25519 CA public key.
 */
function verifyCertSignature(
  certDer: Uint8Array,
  caPubKey: Uint8Array,
): boolean {
  try {
    const parsed = asn1.fromBER(toAB(certDer));
    if (parsed.offset === -1) return false;
    const certFields = (parsed.result as any).valueBlock
      .value as asn1.AsnType[];
    // Certificate ::= SEQUENCE { tbs, sigAlg, signature BIT STRING }
    const tbsDer = toU8(certFields[0].toBER(false));
    // Ed25519 signature BIT STRING DER ends with 64 signature bytes
    const sigDer = toU8(certFields[2].toBER(false));
    if (sigDer.length < 64) return false;
    return ed25519.verify(sigDer.slice(-64), tbsDer, caPubKey);
  } catch {
    return false;
  }
}

/**
 * Extract the Common Name (CN) from the subject of a DER-encoded certificate.
 */
function readCertCN(der: Uint8Array): string | null {
  const subject = getTBSField(der, 4); // subject is TBS field 4
  if (!subject) return null;
  try {
    for (const rdn of (subject as any).valueBlock.value as asn1.Set[]) {
      for (const attr of (rdn as any).valueBlock.value as asn1.Sequence[]) {
        const attrFields = (attr as any).valueBlock.value as asn1.AsnType[];
        if (
          (attrFields[0] as asn1.ObjectIdentifier).valueBlock.toString() ===
          OID_CN
        ) {
          return (attrFields[1] as any).valueBlock.value as string;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the certificate serial number as a lowercase hex string.
 * The serial is TBS field 0 (after the optional v3 version wrapper).
 */
function readCertSerial(der: Uint8Array): string | null {
  const serial = getTBSField(der, 0); // serial is TBS field 0
  if (!serial) return null;
  try {
    const view = (serial as any).valueBlock.valueHexView as Uint8Array;
    return Array.from(view)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/**
 * Extract the notAfter date from a DER-encoded certificate.
 */
function readCertNotAfter(der: Uint8Array): Date | null {
  const validity = getTBSField(der, 3); // validity is TBS field 3
  if (!validity) return null;
  try {
    const fields = (validity as any).valueBlock.value as asn1.AsnType[];
    const notAfterField = fields[1];
    const d = (notAfterField as any).toDate() as Date;
    return d instanceof Date && !isNaN(d.getTime()) ? d : null;
  } catch {
    return null;
  }
}

/**
 * Extract SAN DNS names and IP addresses from a DER-encoded certificate.
 * Returns null when the certificate has no SAN extension.
 */
function readCertSANs(der: Uint8Array): SAN | null {
  try {
    const parsed = asn1.fromBER(toAB(der));
    if (parsed.offset === -1) return null;
    const cert = parsed.result as asn1.Sequence;
    const tbs = (cert as any).valueBlock.value[0] as asn1.Sequence;
    const fields = (tbs as any).valueBlock.value as asn1.AsnType[];
    const extsWrapper = fields.find(
      (f: asn1.AsnType) =>
        f.idBlock.tagClass === 3 && f.idBlock.tagNumber === 3,
    ) as asn1.Constructed | undefined;
    if (!extsWrapper) return null;

    const extsSeq = (extsWrapper as any).valueBlock.value[0] as asn1.Sequence;
    const extensions = (extsSeq as any).valueBlock.value as asn1.Sequence[];

    for (const ext of extensions) {
      const extFields = (ext as any).valueBlock.value as asn1.AsnType[];
      const oid = extFields[0] as asn1.ObjectIdentifier;
      if (oid.valueBlock.toString() !== OID_SAN) continue;

      const extnValue = extFields[extFields.length - 1] as asn1.OctetString;
      const inner = asn1.fromBER(extnValue.valueBlock.valueHexView);
      if (inner.offset === -1) return null;

      const generalNames = (inner.result as any).valueBlock
        .value as asn1.AsnType[];
      const dns: string[] = [];
      const ip: string[] = [];
      const decoder = new TextDecoder();
      for (const gn of generalNames) {
        const tagNum = (gn as any).idBlock.tagNumber;
        const hex = (gn as any).valueBlock.valueHexView as Uint8Array;
        if (tagNum === 2) {
          // dNSName — IA5String bytes
          dns.push(decoder.decode(hex));
        } else if (tagNum === 7 && hex.length === 4) {
          // iPAddress — 4-byte IPv4
          ip.push(Array.from(hex).join("."));
        }
      }
      return dns.length > 0 || ip.length > 0 ? { dns, ip } : null;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Flow entry point
// ---------------------------------------------------------------------------

export function onMessage(message: Message, context: FlowContext): Message[] {
  const {
    ca_private_key,
    ca_cert_der: caCertDerB64,
    cert_validity_days = 365,
    nonce_window_hours = 24,
    factory_ca_public_keys: factoryKeysRaw = "[]",
    require_factory_cert = true,
    keygen_topic = "te/pki/x509/keygen",
    renewal_topic = "te/pki/x509/renew",
    output_cert_topic_prefix = "te/pki/x509/cert/issued",
    output_keygen_topic_prefix = "te/pki/x509/keygen/issued",
    output_renewal_topic_prefix,
    output_rejected_topic = "te/pki/x509/req/rejected",
    renewal_window_days,
    denied_device_ids: deniedDeviceIdsRaw = "[]",
    revoked_cert_serials: revokedCertSerialsRaw = "[]",
    denied_factory_pubkeys: deniedFactoryPubkeysRaw = "[]",
  } = context.config;

  const requireFactoryCert = require_factory_cert !== false;
  const isKeygenRequest = message.topic === keygen_topic;
  const isRenewalRequest = message.topic === renewal_topic;

  const reject = (reason: string): Message[] => {
    console.log(`x509-cert-issuer: rejected — ${reason}`);
    if (!output_rejected_topic) return [];
    let rejPayload: string;
    let rejDeviceId: string | undefined;
    try {
      const orig =
        typeof message.payload === "string"
          ? JSON.parse(message.payload)
          : JSON.parse(new TextDecoder().decode(message.payload));
      if (orig?.device_id) rejDeviceId = String(orig.device_id);
      rejPayload = JSON.stringify({ ...orig, _rejection_reason: reason });
    } catch {
      rejPayload = JSON.stringify({ _rejection_reason: reason });
    }
    const rejTopic = rejDeviceId
      ? `${output_rejected_topic}/${rejDeviceId}`
      : output_rejected_topic;
    return [{ time: message.time, topic: rejTopic, payload: rejPayload }];
  };

  if (!ca_private_key) return reject("ca_private_key not configured");
  if (!caCertDerB64) return reject("ca_cert_der not configured");

  // Coerce a config value that may be a native array or a legacy JSON-encoded string.
  const toStringArray = (raw: string[] | string): string[] | null => {
    if (Array.isArray(raw)) return raw;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : null;
    } catch {
      return null;
    }
  };

  let factoryCAPubKeys: string[] = [];
  if (requireFactoryCert) {
    const parsed = toStringArray(factoryKeysRaw);
    if (!parsed)
      return reject("invalid factory_ca_public_keys — must be an array");
    factoryCAPubKeys = parsed;
    if (factoryCAPubKeys.length === 0)
      return reject("no factory CAs configured");
  }

  const payload = decodeJsonPayload(message.payload);
  const {
    device_id,
    common_name,
    public_key,
    nonce,
    _factory_cert,
    _req_sig,
    _current_cert,
    san_dns_names,
    san_ip_addresses,
  } = payload;

  if (!device_id) {
    return reject("missing required field: device_id");
  }

  // Validate array config params up-front
  const deniedList = toStringArray(deniedDeviceIdsRaw);
  if (!deniedList)
    return reject("invalid denied_device_ids — must be an array");

  const revokedSerials = toStringArray(revokedCertSerialsRaw);
  if (!revokedSerials)
    return reject("invalid revoked_cert_serials — must be an array");

  const deniedFactoryPubkeys = toStringArray(deniedFactoryPubkeysRaw);
  if (!deniedFactoryPubkeys)
    return reject("invalid denied_factory_pubkeys — must be an array");

  // Coarse device-level block — applied to all request types.
  // Prefer revoked_cert_serials + denied_factory_pubkeys for fine-grained revocation.
  if (deniedList.includes(String(device_id)))
    return reject(`device_id "${device_id}" is denied`);
  // Nonce is optional but strongly recommended for anti-replay protection.
  // It is required only when signature verification is needed (factory cert or renewal).
  if (!nonce && (requireFactoryCert || isRenewalRequest)) {
    return reject("missing required field: nonce");
  }
  if (!isKeygenRequest && !public_key) {
    return reject("missing required field: public_key");
  }

  // Anti-replay nonce check (skipped when no nonce is provided)
  const nonces: Record<string, number> = context.script.get("nonces") || {};
  const now = Date.now();
  if (nonce) {
    const ttlMs = Number(nonce_window_hours) * 3600_000;
    for (const n of Object.keys(nonces)) {
      if (now - nonces[n] > ttlMs) delete nonces[n];
    }
    if (nonces[nonce as string] !== undefined)
      return reject("nonce already used");
  }

  // Factory certificate verification (optional based on config, skipped for renewals)
  if (requireFactoryCert && !isRenewalRequest) {
    if (!_factory_cert) return reject("missing required field: _factory_cert");
    const factoryResult = verifyFactoryCert(
      _factory_cert as string,
      String(device_id),
      factoryCAPubKeys,
    );
    if (!factoryResult.valid) return reject(factoryResult.reason);

    // CRL-style factory credential revocation: reject specific compromised keys
    // without permanently blocking the device identity. Re-provisioning the device
    // with a new factory key (fresh burn) restores enrollment capability.
    if (deniedFactoryPubkeys.includes(factoryResult.factoryPubKeyB64))
      return reject("factory certificate public key is revoked");

    if (!_req_sig) return reject("missing required field: _req_sig");
    // Keygen requests sign {device_id, nonce}; CSR requests sign {device_id, nonce, public_key}
    const reqSigOk = isKeygenRequest
      ? verifyKeygenReqSig(
          String(device_id),
          String(nonce),
          _req_sig as string,
          factoryResult.factoryPubKeyB64,
        )
      : verifyReqSig(
          String(device_id),
          String(nonce),
          String(public_key),
          _req_sig as string,
          factoryResult.factoryPubKeyB64,
        );
    if (!reqSigOk) return reject("request signature invalid");
  } else if (isRenewalRequest) {
    // Renewal: device proves possession of a valid CA-issued certificate by signing
    // the request with the corresponding private key (proof of possession).
    if (!_current_cert) return reject("missing required field: _current_cert");
    if (!_req_sig) return reject("missing required field: _req_sig");

    let currentCertDer: Uint8Array;
    try {
      currentCertDer = atobBytes(_current_cert as string);
    } catch {
      return reject("failed to decode _current_cert");
    }

    // Verify cert was issued by this CA (prevents use of self-signed or third-party certs)
    const caPubKeyBytesForRenew = ed25519.getPublicKey(
      atobBytes(ca_private_key),
    );
    if (!verifyCertSignature(currentCertDer, caPubKeyBytesForRenew)) {
      return reject("current certificate not issued by this CA");
    }

    // CRL-style serial revocation: block renewal of a specific compromised certificate
    // without blocking future enrollments. After the device re-enrolls it gets a fresh
    // serial and is no longer covered by this check.
    if (revokedSerials.length > 0) {
      const currentSerial = readCertSerial(currentCertDer);
      if (currentSerial !== null && revokedSerials.includes(currentSerial))
        return reject(`certificate serial ${currentSerial} is revoked`);
    }

    // Verify the certificate CN matches the claimed device_id
    const certCN = readCertCN(currentCertDer);
    if (certCN !== String(device_id)) {
      return reject(
        `certificate CN "${certCN}" does not match device_id "${device_id}"`,
      );
    }

    // Verify the certificate has not expired
    const currentCertNotAfter = readCertNotAfter(currentCertDer);
    if (!currentCertNotAfter || currentCertNotAfter < new Date()) {
      return reject("current certificate is expired");
    }

    // Optionally enforce a renewal window (e.g. only allow within 30 days of expiry)
    if (renewal_window_days !== undefined) {
      const windowMs = Number(renewal_window_days) * 86_400_000;
      if (currentCertNotAfter.getTime() - Date.now() > windowMs) {
        return reject(
          `renewal only allowed within ${renewal_window_days} days of certificate expiry`,
        );
      }
    }

    // Verify request signature with the current certificate's public key (proof of possession)
    const certPubKeyBytes = readCertPublicKeyBytes(currentCertDer);
    if (!certPubKeyBytes)
      return reject("failed to extract public key from current certificate");
    if (
      !verifyReqSig(
        String(device_id),
        String(nonce),
        String(public_key),
        _req_sig as string,
        uint8ToBase64(certPubKeyBytes),
      )
    ) {
      return reject("request signature invalid");
    }
  }

  // Record nonce (only when one was provided)
  if (nonce) {
    nonces[nonce as string] = now;
    context.script.set("nonces", nonces);
  }

  // Extract issuer name bytes verbatim from the CA cert so that the issued cert's
  // issuer field is byte-for-byte identical to the CA cert's subject field.
  // This is required for OpenSSL (and RFC 5280) name matching during chain verification.
  const caCertDer = atobBytes(caCertDerB64);
  const issuerNameDer = readDerSubjectBytes(caCertDer);
  if (!issuerNameDer)
    return reject("failed to parse subject name from CA certificate");
  // Extract the CA cert's verbatim SKID so we can embed it as the AKI in the issued cert.
  // OpenSSL compares AKI↔SKID bytes directly; re-computing with a different algorithm breaks the chain.
  const issuerKeyId = readDerSKID(caCertDer) ?? undefined;

  // Determine subject CN: prefer explicit common_name, fall back to device_id
  const subjectCN = common_name ? String(common_name) : String(device_id);

  // Derive serial from CA key + device_id + nonce + timestamp.
  // Using a hash avoids depending on crypto.getRandomValues while still giving
  // a unique, collision-resistant value per request (nonce is anti-replayed).
  const serialInput = new TextEncoder().encode(
    ca_private_key +
      "|" +
      String(device_id) +
      "|" +
      String(nonce) +
      "|" +
      String(now),
  );
  const serial = sha256(serialInput).slice(0, 19);
  serial[0] &= 0x7f; // keep positive

  // Validity window
  const notBefore = new Date();
  const notAfter = new Date(
    notBefore.getTime() + Number(cert_validity_days) * 86_400_000,
  );

  // Determine the key to certify — either provided by device (CSR) or generated here (keygen)
  let devicePubKeyBytes: Uint8Array;
  let generatedPrivKeyDer: string | undefined;
  if (isKeygenRequest) {
    const privKey = safeRandomBytes(32);
    devicePubKeyBytes = ed25519.getPublicKey(privKey);
    generatedPrivKeyDer = uint8ToBase64(buildPrivKeyDER(privKey));
  } else {
    devicePubKeyBytes = atobBytes(String(public_key));
  }

  const caPubKeyBytes = ed25519.getPublicKey(atobBytes(ca_private_key));

  // Parse optional SAN fields from the request payload.
  // For renewals: if no SANs are provided, carry them forward from the current certificate.
  let san: SAN | undefined;
  try {
    const dnsList: string[] = san_dns_names
      ? Array.isArray(san_dns_names)
        ? san_dns_names
        : JSON.parse(String(san_dns_names))
      : [];
    const ipList: string[] = san_ip_addresses
      ? Array.isArray(san_ip_addresses)
        ? san_ip_addresses
        : JSON.parse(String(san_ip_addresses))
      : [];
    if (dnsList.length > 0 || ipList.length > 0) {
      san = { dns: dnsList, ip: ipList };
    } else if (isRenewalRequest) {
      // No SANs in the renewal request — inherit from the current certificate.
      const currentCertForSAN = atobBytes(_current_cert as string);
      san = readCertSANs(currentCertForSAN) ?? undefined;
    }
  } catch {
    return reject(
      "invalid san_dns_names or san_ip_addresses — must be JSON arrays",
    );
  }

  const tbs = buildTBS({
    serialNumber: serial,
    issuerNameDer,
    notBefore,
    notAfter,
    subjectCN,
    subjectPubKey: devicePubKeyBytes,
    issuerPubKey: caPubKeyBytes,
    issuerKeyId,
    isCA: false,
    san,
  });

  const certDer = signCert(tbs, ca_private_key);

  // Compute the hex serial of the newly issued certificate so it can be
  // returned to the operator and later listed in revoked_cert_serials if needed.
  const certSerialHex = readCertSerial(certDer) ?? "";

  const mode = isKeygenRequest ? "keygen" : isRenewalRequest ? "renew" : "csr";
  console.log(
    `x509-cert-issuer: issued cert [${mode}] CN="${subjectCN}" serial=${certSerialHex} expires=${notAfter.toISOString()}`,
  );

  const outputTopic = isKeygenRequest
    ? `${output_keygen_topic_prefix}/${device_id}`
    : isRenewalRequest
      ? `${output_renewal_topic_prefix ?? output_cert_topic_prefix}/${device_id}`
      : `${output_cert_topic_prefix}/${device_id}`;

  const responsePayload: Record<string, string> = {
    device_id: String(device_id),
    cert_serial: certSerialHex,
    cert_der: uint8ToBase64(certDer),
    cert_pem: derToPem("CERTIFICATE", certDer),
    ca_cert_der: uint8ToBase64(caCertDer),
    ca_cert_pem: derToPem("CERTIFICATE", caCertDer),
  };
  if (isKeygenRequest) {
    responsePayload.private_key_der = generatedPrivKeyDer!;
    responsePayload.private_key_pem = derToPem(
      "PRIVATE KEY",
      atobBytes(generatedPrivKeyDer!),
    );
  }

  return [
    {
      time: new Date(),
      topic: outputTopic,
      payload: JSON.stringify(responsePayload),
    },
  ];
}
