import { Message, Context, decodeJsonPayload, uint8ToBase64 } from "../../common/tedge";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import * as asn1 from "asn1js";

export interface Config {
  debug?: boolean;
  /**
   * Hex-encoded 32-byte Ed25519 private key of this CA.
   * Generate with: openssl pkey -in ca.pem -outform DER | tail -c 32 | xxd -p -c 32
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
   * JSON array of trusted factory CA public keys (hex-encoded Ed25519).
   * A device must present a factory certificate signed by one of these CAs to
   * prove device identity before a certificate is issued.
   * Example: '["aabbcc...", "ddeeff..."]'
   */
  factory_ca_public_keys?: string;
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
}

export interface FlowContext extends Context {
  config: Config;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

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

// Base64 decode without atob (not available in QuickJS)
function atobBytes(base64: string): Uint8Array {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = base64.replace(/[\s=]+$/g, "");
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

/**
 * Cryptographically secure random bytes.
 * Uses crypto.getRandomValues when available (Node.js, modern browsers);
 * falls back to a Math.random()-based PRNG when running in constrained JS
 * environments (e.g. rquickjs). The fallback is suitable for serial numbers
 * but NOT for generating private keys in production.
 */
function safeRandomBytes(n: number): Uint8Array {
  if (typeof crypto !== "undefined" && typeof (crypto as any).getRandomValues === "function") {
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

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ASN.1 / DER helpers using asn1js
// ---------------------------------------------------------------------------

/** Convert Uint8Array to ArrayBuffer (safe for sub-views). */
function toAB(arr: Uint8Array): ArrayBuffer {
  return (arr.buffer as ArrayBuffer).slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
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

function algIdEd25519(): asn1.Sequence {
  return new asn1.Sequence({ value: [
    new asn1.ObjectIdentifier({ value: OID_ED25519 }),
  ]});
}

function rdnName(cn: string): asn1.Sequence {
  return new asn1.Sequence({ value: [
    new asn1.Set({ value: [
      new asn1.Sequence({ value: [
        new asn1.ObjectIdentifier({ value: OID_CN }),
        new asn1.Utf8String({ value: cn }),
      ]}),
    ]}),
  ]});
}

function asnSubjectPublicKeyInfo(pubKeyBytes: Uint8Array): asn1.Sequence {
  return new asn1.Sequence({ value: [
    algIdEd25519(),
    new asn1.BitString({ valueHex: toAB(pubKeyBytes) }),
  ]});
}

/** SHA-256 of the raw public key bytes truncated to 160 bits (RFC 7093 Method 1). */
function keyIdentifier(pubKeyBytes: Uint8Array): Uint8Array {
  return sha256(pubKeyBytes).slice(0, 20);
}

function buildExtensions(
  subjectPubKey: Uint8Array,
  issuerPubKey: Uint8Array,
  isCA: boolean,
  issuerKeyId?: Uint8Array,
): asn1.Constructed {
  const skiValue = keyIdentifier(subjectPubKey);
  // Use the CA cert's verbatim SKID bytes (extracted via readDerSKID) when available,
  // so that OpenSSL's AKI↔SKID comparison succeeds regardless of the CA's hash algorithm.
  const akiValue = issuerKeyId ?? keyIdentifier(issuerPubKey);

  // SKI extension: extnValue wraps OCTET STRING containing the key id
  const skiExt = new asn1.Sequence({ value: [
    new asn1.ObjectIdentifier({ value: OID_SKI }),
    new asn1.OctetString({
      valueHex: new asn1.OctetString({ valueHex: toAB(skiValue) }).toBER(false),
    }),
  ]});

  // AKI extension: extnValue wraps SEQUENCE { [0] IMPLICIT keyIdentifier }
  const akiBody = new asn1.Sequence({ value: [
    new asn1.Primitive({
      idBlock: { tagClass: 3, tagNumber: 0 },
      valueHex: toAB(akiValue),
    }),
  ]});
  const akiExt = new asn1.Sequence({ value: [
    new asn1.ObjectIdentifier({ value: OID_AKI }),
    new asn1.OctetString({ valueHex: akiBody.toBER(false) }),
  ]});

  const exts: asn1.Sequence[] = [skiExt, akiExt];

  if (isCA) {
    // BasicConstraints: critical=true, cA=true
    const bcBody = new asn1.Sequence({ value: [
      new asn1.Boolean({ value: true }), // cA = TRUE
    ]});
    const bcExt = new asn1.Sequence({ value: [
      new asn1.ObjectIdentifier({ value: OID_BASIC_CONSTRAINTS }),
      new asn1.Boolean({ value: true }), // critical
      new asn1.OctetString({ valueHex: bcBody.toBER(false) }),
    ]});
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

  const tbs = new asn1.Sequence({ value: [
    version,
    serial,
    algIdEd25519(),
    issuerParsed.result,
    new asn1.Sequence({ value: [
      new asn1.UTCTime({ valueDate: opts.notBefore }),
      new asn1.UTCTime({ valueDate: opts.notAfter }),
    ]}),
    rdnName(opts.subjectCN),
    asnSubjectPublicKeyInfo(opts.subjectPubKey),
    buildExtensions(opts.subjectPubKey, opts.issuerPubKey, opts.isCA, opts.issuerKeyId),
  ]});

  return toU8(tbs.toBER(false));
}

/**
 * Wrap a 32-byte Ed25519 private key seed in PKCS#8 DER (RFC 8410).
 */
function buildPrivKeyDER(privKeyBytes: Uint8Array): Uint8Array {
  const pkcs8 = new asn1.Sequence({ value: [
    new asn1.Integer({ value: 0 }), // version
    algIdEd25519(),
    new asn1.OctetString({
      valueHex: new asn1.OctetString({ valueHex: toAB(privKeyBytes) }).toBER(false),
    }),
  ]});
  return toU8(pkcs8.toBER(false));
}

/**
 * Sign a TBSCertificate and wrap in a full Certificate DER.
 */
function signCert(tbs: Uint8Array, caPrivKeyHex: string): Uint8Array {
  const sig = ed25519.sign(tbs, hexToBytes(caPrivKeyHex));
  const tbsParsed = asn1.fromBER(toAB(tbs));
  const cert = new asn1.Sequence({ value: [
    tbsParsed.result,
    algIdEd25519(),
    new asn1.BitString({ valueHex: toAB(sig) }),
  ]});
  return toU8(cert.toBER(false));
}

/**
 * Encode a DER byte array as a PEM string.
 */
function toPEM(label: string, der: Uint8Array): string {
  const b64 = uint8ToBase64(der);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

// ---------------------------------------------------------------------------
// Factory certificate verification (same format as pki-issuer)
// ---------------------------------------------------------------------------

function verifyFactoryCert(
  factoryCertB64: string,
  deviceId: string,
  factoryCAPubKeys: string[],
): { valid: false; reason: string } | { valid: true; factoryPubKeyHex: string } {
  let cert: Record<string, string>;
  try {
    cert = JSON.parse(atobToString(factoryCertB64));
  } catch {
    return { valid: false, reason: "invalid _factory_cert encoding" };
  }

  const { _cert_sig, ...certBody } = cert;
  if (!_cert_sig) return { valid: false, reason: "factory cert missing _cert_sig" };

  const encoder = new TextEncoder();
  const canonical = JSON.stringify(certBody, Object.keys(certBody).sort());

  const certValid = factoryCAPubKeys.some((caPubKey) => {
    try {
      return ed25519.verify(atobBytes(_cert_sig), encoder.encode(canonical), hexToBytes(caPubKey));
    } catch {
      return false;
    }
  });
  if (!certValid) return { valid: false, reason: "factory certificate signature invalid" };

  if (cert.device_id !== deviceId) {
    return {
      valid: false,
      reason: `device_id mismatch: factory cert has "${cert.device_id}", request has "${deviceId}"`,
    };
  }

  if (cert.expires && new Date(cert.expires) < new Date()) {
    return { valid: false, reason: `factory certificate expired: ${cert.expires}` };
  }

  return { valid: true, factoryPubKeyHex: cert.public_key };
}

function verifyReqSig(
  deviceId: string,
  nonce: string,
  publicKey: string,
  reqSigB64: string,
  factoryPubKeyHex: string,
): boolean {
  try {
    const reqBody = { device_id: deviceId, nonce, public_key: publicKey };
    const encoder = new TextEncoder();
    const canonical = JSON.stringify(reqBody, Object.keys(reqBody).sort());
    return ed25519.verify(atobBytes(reqSigB64), encoder.encode(canonical), hexToBytes(factoryPubKeyHex));
  } catch {
    return false;
  }
}

/** Verify proof-of-possession for keygen requests (no public_key to include). */
function verifyKeygenReqSig(
  deviceId: string,
  nonce: string,
  reqSigB64: string,
  factoryPubKeyHex: string,
): boolean {
  try {
    const reqBody = { device_id: deviceId, nonce };
    const encoder = new TextEncoder();
    const canonical = JSON.stringify(reqBody, Object.keys(reqBody).sort());
    return ed25519.verify(atobBytes(reqSigB64), encoder.encode(canonical), hexToBytes(factoryPubKeyHex));
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
function getTBSField(certDer: Uint8Array, fieldIndex: number): asn1.AsnType | null {
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
      (f: asn1.AsnType) => f.idBlock.tagClass === 3 && f.idBlock.tagNumber === 3,
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
      return toU8((view.buffer as ArrayBuffer).slice(view.byteOffset, view.byteOffset + view.byteLength));
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the issuer CN from a DER certificate.
 */
function readDerCN(der: Uint8Array): string | null {
  try {
    const issuerName = getTBSField(der, 2); // issuer is field index 2
    if (!issuerName) return null;
    // Name → SET (RDN) → SEQUENCE (AttributeTypeAndValue) → value
    const rdnSets = (issuerName as any).valueBlock.value as asn1.Set[];
    for (const rdnSet of rdnSets) {
      const atvSeqs = (rdnSet as any).valueBlock.value as asn1.Sequence[];
      for (const atv of atvSeqs) {
        const atvFields = (atv as any).valueBlock.value as asn1.AsnType[];
        const oid = atvFields[0] as asn1.ObjectIdentifier;
        if (oid.valueBlock.toString() !== OID_CN) continue;
        const val = atvFields[1];
        // Works for Utf8String, PrintableString, etc.
        if ("value" in val.valueBlock && typeof (val.valueBlock as any).value === "string") {
          return (val.valueBlock as any).value;
        }
        return new TextDecoder().decode((val as any).valueBlock.valueHexView);
      }
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
    debug = false,
    ca_private_key,
    ca_cert_der: caCertDerB64,
    cert_validity_days = 365,
    nonce_window_hours = 24,
    factory_ca_public_keys: factoryKeysJson = "[]",
    require_factory_cert = true,
    keygen_topic = "te/pki/x509/keygen",
    output_cert_topic_prefix = "te/pki/x509/cert/issued",
    output_keygen_topic_prefix = "te/pki/x509/keygen/issued",
    output_rejected_topic = "te/pki/x509/req/rejected",
  } = context.config;

  const requireFactoryCert = require_factory_cert !== false;
  const isKeygenRequest = message.topic === keygen_topic;

  const reject = (reason: string): Message[] => {
    if (debug) console.log(`x509-cert-issuer: rejected — ${reason}`);
    return output_rejected_topic
      ? [{ time: message.time, topic: output_rejected_topic, payload: message.payload }]
      : [];
  };

  if (!ca_private_key) return reject("ca_private_key not configured");
  if (!caCertDerB64) return reject("ca_cert_der not configured");

  let factoryCAPubKeys: string[] = [];
  if (requireFactoryCert) {
    try {
      const parsed = JSON.parse(factoryKeysJson);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      factoryCAPubKeys = parsed as string[];
    } catch {
      return reject("invalid factory_ca_public_keys — must be a JSON array");
    }
    if (factoryCAPubKeys.length === 0) return reject("no factory CAs configured");
  }

  const payload = decodeJsonPayload(message.payload);
  const { device_id, common_name, public_key, nonce, _factory_cert, _req_sig } = payload;

  if (!device_id || !nonce) {
    return reject("missing required fields: device_id, nonce");
  }
  if (!isKeygenRequest && !public_key) {
    return reject("missing required field: public_key");
  }

  // Anti-replay nonce check
  const nonces: Record<string, number> = context.script.get("nonces") || {};
  const now = Date.now();
  const ttlMs = Number(nonce_window_hours) * 3600_000;
  for (const n of Object.keys(nonces)) {
    if (now - nonces[n] > ttlMs) delete nonces[n];
  }
  if (nonces[nonce as string] !== undefined) return reject("nonce already used");

  // Factory certificate verification (optional based on config)
  if (requireFactoryCert) {
    if (!_factory_cert) return reject("missing required field: _factory_cert");
    const factoryResult = verifyFactoryCert(
      _factory_cert as string,
      String(device_id),
      factoryCAPubKeys,
    );
    if (!factoryResult.valid) return reject(factoryResult.reason);

    if (!_req_sig) return reject("missing required field: _req_sig");
    // Keygen requests sign {device_id, nonce}; CSR requests sign {device_id, nonce, public_key}
    const reqSigOk = isKeygenRequest
      ? verifyKeygenReqSig(String(device_id), String(nonce), _req_sig as string, factoryResult.factoryPubKeyHex)
      : verifyReqSig(String(device_id), String(nonce), String(public_key), _req_sig as string, factoryResult.factoryPubKeyHex);
    if (!reqSigOk) return reject("request signature invalid");
  }

  // Record nonce
  nonces[nonce as string] = now;
  context.script.set("nonces", nonces);

  // Extract issuer name bytes verbatim from the CA cert so that the issued cert's
  // issuer field is byte-for-byte identical to the CA cert's subject field.
  // This is required for OpenSSL (and RFC 5280) name matching during chain verification.
  const caCertDer = atobBytes(caCertDerB64);
  const issuerNameDer = readDerSubjectBytes(caCertDer);
  if (!issuerNameDer) return reject("failed to parse subject name from CA certificate");
  // Extract the CA cert's verbatim SKID so we can embed it as the AKI in the issued cert.
  // OpenSSL compares AKI↔SKID bytes directly; re-computing with a different algorithm breaks the chain.
  const issuerKeyId = readDerSKID(caCertDer) ?? undefined;

  // Determine subject CN: prefer explicit common_name, fall back to device_id
  const subjectCN = common_name ? String(common_name) : String(device_id);

  // Derive serial from CA key + device_id + nonce + timestamp.
  // Using a hash avoids depending on crypto.getRandomValues while still giving
  // a unique, collision-resistant value per request (nonce is anti-replayed).
  const serialInput = new TextEncoder().encode(ca_private_key + "|" + String(device_id) + "|" + String(nonce) + "|" + String(now));
  const serial = sha256(serialInput).slice(0, 19);
  serial[0] &= 0x7f; // keep positive

  // Validity window
  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + Number(cert_validity_days) * 86_400_000);

  // Determine the key to certify — either provided by device (CSR) or generated here (keygen)
  let devicePubKeyBytes: Uint8Array;
  let generatedPrivKeyDer: string | undefined;
  if (isKeygenRequest) {
    const privKey = safeRandomBytes(32);
    devicePubKeyBytes = ed25519.getPublicKey(privKey);
    generatedPrivKeyDer = uint8ToBase64(buildPrivKeyDER(privKey));
  } else {
    devicePubKeyBytes = hexToBytes(String(public_key));
  }

  const caPubKeyBytes = ed25519.getPublicKey(hexToBytes(ca_private_key));

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
  });

  const certDer = signCert(tbs, ca_private_key);

  if (debug) {
    const mode = isKeygenRequest ? "keygen" : "csr";
    console.log(
      `x509-cert-issuer: issued cert [${mode}] CN="${subjectCN}" expires=${notAfter.toISOString()}`,
    );
  }

  const outputTopic = isKeygenRequest
    ? `${output_keygen_topic_prefix}/${device_id}`
    : `${output_cert_topic_prefix}/${device_id}`;

  const responsePayload: Record<string, string> = {
    device_id: String(device_id),
    cert_der: uint8ToBase64(certDer),
    ca_cert_der: uint8ToBase64(caCertDer),
  };
  if (isKeygenRequest) {
    responsePayload.private_key_der = generatedPrivKeyDer!;
  }

  return [{ time: new Date(), topic: outputTopic, payload: JSON.stringify(responsePayload) }];
}
