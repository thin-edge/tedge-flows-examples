import { expect, test, describe, beforeAll } from "@jest/globals";
import * as crypto from "crypto";
import * as tedge from "../../common/tedge";
import { uint8ToBase64 } from "../../common/tedge";
import * as flow from "../src/main";
import { ed25519 } from "@noble/curves/ed25519.js";
import { fromBER, Sequence } from "asn1js";

// ---------------------------------------------------------------------------
// Key material — generated fresh per test run
// ---------------------------------------------------------------------------

// Factory CA (manufacturer)
const FACTORY_CA_PRIV_BYTES = ed25519.utils.randomSecretKey();
const FACTORY_CA_PRIV = bytesToHex(FACTORY_CA_PRIV_BYTES);
const FACTORY_CA_PUB = uint8ToBase64(
  ed25519.getPublicKey(FACTORY_CA_PRIV_BYTES),
);

// Factory CA 2 (second manufacturer — for multi-CA tests)
const FACTORY_CA2_PRIV_BYTES = ed25519.utils.randomSecretKey();
const FACTORY_CA2_PRIV = bytesToHex(FACTORY_CA2_PRIV_BYTES);
const FACTORY_CA2_PUB = uint8ToBase64(
  ed25519.getPublicKey(FACTORY_CA2_PRIV_BYTES),
);

// Factory device key pair (burned in at manufacturing)
const FACTORY_DEV_PRIV_BYTES = ed25519.utils.randomSecretKey();
const FACTORY_DEV_PRIV = bytesToHex(FACTORY_DEV_PRIV_BYTES);
const FACTORY_DEV_PUB = uint8ToBase64(
  ed25519.getPublicKey(FACTORY_DEV_PRIV_BYTES),
);

// Operational key pair (what the device wants an X.509 cert for)
const OP_PRIV_BYTES = ed25519.utils.randomSecretKey();
const OP_PRIV = bytesToHex(OP_PRIV_BYTES);
const OP_PUB = uint8ToBase64(ed25519.getPublicKey(OP_PRIV_BYTES));

const DEVICE_ID = "my-device-001";

// Operational CA (the gateway running x509-cert-issuer)
// We generate this using Node crypto so we have a real X.509 CA cert to work with
let CA_PRIV_B64: string;
let CA_CERT_DER_B64: string;
let CA_CERT_PEM: string;

// ---------------------------------------------------------------------------
// Helpers
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

/**
 * Parse a DER certificate and return a TBS field by index.
 * TBS fields: version? | serial(0) | sigAlg(1) | issuer(2) | validity(3) | subject(4) | SPKI(5)
 */
function getTBSFieldDer(certDer: Buffer, fieldIndex: number): Buffer {
  const ab = certDer.buffer.slice(
    certDer.byteOffset,
    certDer.byteOffset + certDer.byteLength,
  ) as ArrayBuffer;
  const parsed = fromBER(ab);
  if (parsed.offset === -1) throw new Error("invalid DER");
  const cert = parsed.result as Sequence;
  const tbs = (cert as any).valueBlock.value[0] as Sequence;
  const fields = (tbs as any).valueBlock.value;
  let idx = 0;
  if (fields[0].idBlock.tagClass === 3 && fields[0].idBlock.tagNumber === 0)
    idx++;
  const field = fields[idx + fieldIndex];
  return Buffer.from(field.toBER(false));
}

function extractIssuerNameDer(certDer: Buffer): Buffer {
  return getTBSFieldDer(certDer, 2); // issuer is field 2
}

function extractSubjectNameDer(certDer: Buffer): Buffer {
  return getTBSFieldDer(certDer, 4); // subject is field 4
}

function makeFactoryCert(
  deviceId: string,
  devicePubHex: string,
  caPrivHex: string,
  expires?: string,
): string {
  const body: Record<string, string> = {
    device_id: deviceId,
    public_key: devicePubHex,
  };
  if (expires) body.expires = expires;
  const encoder = new TextEncoder();
  const canonical = JSON.stringify(body, Object.keys(body).sort());
  const sig = ed25519.sign(encoder.encode(canonical), hexToBytes(caPrivHex));
  const cert = { ...body, _cert_sig: uint8ToBase64(sig) };
  return uint8ToBase64(encoder.encode(JSON.stringify(cert)));
}

function makeReqSig(
  deviceId: string,
  nonce: string,
  publicKey: string,
  factoryPrivHex: string,
): string {
  const body = { device_id: deviceId, nonce, public_key: publicKey };
  const encoder = new TextEncoder();
  const canonical = JSON.stringify(body, Object.keys(body).sort());
  const sig = ed25519.sign(
    encoder.encode(canonical),
    hexToBytes(factoryPrivHex),
  );
  return uint8ToBase64(sig);
}

function makeRequest(opts: {
  device_id?: string;
  public_key?: string;
  nonce?: string;
  factory_cert?: string;
  req_sig?: string;
}): tedge.Message {
  return {
    time: new Date(),
    topic: "te/pki/x509/csr",
    payload: JSON.stringify({
      device_id: opts.device_id ?? DEVICE_ID,
      public_key: opts.public_key ?? OP_PUB,
      nonce: opts.nonce ?? "test-nonce",
      _factory_cert: opts.factory_cert,
      _req_sig: opts.req_sig,
    }),
  };
}

/** Build a fully valid certificate request */
function makeValidRequest(
  nonce = "valid-nonce",
  opPub = OP_PUB,
  factoryPriv = FACTORY_DEV_PRIV,
): tedge.Message {
  const factoryCert = makeFactoryCert(
    DEVICE_ID,
    FACTORY_DEV_PUB,
    FACTORY_CA_PRIV,
  );
  const reqSig = makeReqSig(DEVICE_ID, nonce, opPub, factoryPriv);
  return makeRequest({
    device_id: DEVICE_ID,
    public_key: opPub,
    nonce,
    factory_cert: factoryCert,
    req_sig: reqSig,
  });
}

function makeIssuerContext(extra: Record<string, unknown> = {}) {
  return tedge.createContext({
    ca_private_key: CA_PRIV_B64,
    ca_cert_der: CA_CERT_DER_B64,
    factory_ca_public_keys: JSON.stringify([FACTORY_CA_PUB]),
    ...extra,
  });
}

/** Parse the cert_der from a flow output message and return the Node.js X509Certificate */
function parseCertFromOutput(output: tedge.Message[]): crypto.X509Certificate {
  expect(output).toHaveLength(1);
  const resp = JSON.parse(output[0].payload as string);
  return new crypto.X509Certificate(Buffer.from(resp.cert_der, "base64"));
}

// ---------------------------------------------------------------------------
// One-time setup: generate a real Ed25519 CA key pair + self-signed cert
// ---------------------------------------------------------------------------

beforeAll(() => {
  // Generate CA key pair using Node crypto
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");

  // Extract raw 32-byte private key scalar
  const privDer = privateKey.export({ type: "pkcs8", format: "der" });
  CA_PRIV_B64 = Buffer.from(privDer.slice(-32)).toString("base64");

  // Generate a self-signed CA certificate
  const caCert = crypto.X509Certificate
    ? (() => {
        const { spawnSync } = require("child_process");
        const fs = require("fs");
        const os = require("os");
        // OpenSSL 3.0 on Linux refuses to read a non-seekable pipe for -key,
        // so write everything into an isolated temp directory.
        // Use spawnSync with an argument array (no shell) to avoid shell injection.
        const tmpDir = fs.mkdtempSync(
          require("path").join(os.tmpdir(), "jest-x509-ca-setup-"),
        );
        try {
          const tmpKey = require("path").join(tmpDir, "ca-key.pem");
          const tmpCert = require("path").join(tmpDir, "ca-cert.pem");
          fs.writeFileSync(
            tmpKey,
            privateKey.export({ type: "pkcs8", format: "pem" }) as string,
            { mode: 0o600 },
          );
          const req = spawnSync(
            "openssl",
            [
              "req",
              "-new",
              "-x509",
              "-key",
              tmpKey,
              "-out",
              tmpCert,
              "-days",
              "3650",
              "-subj",
              "/CN=TestCA",
            ],
            { stdio: "pipe" },
          );
          if (req.status !== 0)
            throw new Error(`openssl req failed: ${req.stderr?.toString()}`);
          CA_CERT_PEM = fs.readFileSync(tmpCert, "utf8");
          const der = spawnSync(
            "openssl",
            ["x509", "-in", tmpCert, "-outform", "DER"],
            { stdio: "pipe" },
          );
          if (der.status !== 0)
            throw new Error(`openssl x509 failed: ${der.stderr?.toString()}`);
          CA_CERT_DER_B64 = (der.stdout as Buffer).toString("base64");
        } finally {
          fs.rmSync(tmpDir, { recursive: true });
        }
        return new crypto.X509Certificate(CA_CERT_PEM);
      })()
    : null;
});

// ---------------------------------------------------------------------------
// Certificate issuance — happy path
// ---------------------------------------------------------------------------

describe("certificate issuance — happy path", () => {
  test("valid request produces a response on the expected topic", () => {
    const ctx = makeIssuerContext();
    const output = flow.onMessage(makeValidRequest(), ctx);

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe(`te/pki/x509/cert/issued/${DEVICE_ID}`);
  });

  test("response contains cert_der, ca_cert_der, and device_id", () => {
    const ctx = makeIssuerContext();
    const output = flow.onMessage(makeValidRequest("nonce-fields"), ctx);
    const resp = JSON.parse(output[0].payload as string);

    expect(resp.device_id).toBe(DEVICE_ID);
    expect(resp.cert_der).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(resp.ca_cert_der).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  test("issued cert is a valid X.509 certificate parseable by Node crypto", () => {
    const ctx = makeIssuerContext();
    const cert = parseCertFromOutput(
      flow.onMessage(makeValidRequest("nonce-x509"), ctx),
    );
    expect(cert.subject).toContain(DEVICE_ID);
  });

  test("issued cert subject CN matches device_id by default", () => {
    const ctx = makeIssuerContext();
    const cert = parseCertFromOutput(
      flow.onMessage(makeValidRequest("nonce-cn"), ctx),
    );
    expect(cert.subject).toMatch(/CN\s*=\s*my-device-001/);
  });

  test("explicit common_name overrides device_id in subject CN", () => {
    const factoryCert = makeFactoryCert(
      DEVICE_ID,
      FACTORY_DEV_PUB,
      FACTORY_CA_PRIV,
    );
    const reqSig = makeReqSig(
      DEVICE_ID,
      "nonce-cn-override",
      OP_PUB,
      FACTORY_DEV_PRIV,
    );
    const msg: tedge.Message = {
      time: new Date(),
      topic: "te/pki/x509/csr",
      payload: JSON.stringify({
        device_id: DEVICE_ID,
        common_name: "custom-cn.local",
        public_key: OP_PUB,
        nonce: "nonce-cn-override",
        _factory_cert: factoryCert,
        _req_sig: reqSig,
      }),
    };
    const ctx = makeIssuerContext();
    const cert = parseCertFromOutput(flow.onMessage(msg, ctx));
    expect(cert.subject).toMatch(/CN\s*=\s*custom-cn\.local/);
  });

  test("issued cert issuer CN matches CA cert", () => {
    const ctx = makeIssuerContext();
    const cert = parseCertFromOutput(
      flow.onMessage(makeValidRequest("nonce-issuer"), ctx),
    );
    expect(cert.issuer).toMatch(/CN\s*=\s*TestCA/);
  });

  test("ca_cert_der in response matches the configured CA cert", () => {
    const ctx = makeIssuerContext();
    const output = flow.onMessage(makeValidRequest("nonce-ca-pem"), ctx);
    const resp = JSON.parse(output[0].payload as string);
    const returnedCA = new crypto.X509Certificate(
      Buffer.from(resp.ca_cert_der, "base64"),
    );
    const configuredCA = new crypto.X509Certificate(CA_CERT_PEM);
    expect(returnedCA.serialNumber).toBe(configuredCA.serialNumber);
  });

  test("issued cert is not a CA (isCA=false)", () => {
    const ctx = makeIssuerContext();
    const cert = parseCertFromOutput(
      flow.onMessage(makeValidRequest("nonce-isca"), ctx),
    );
    // ca flag absent or false
    expect(cert.ca).toBe(false);
  });

  test("issued cert is signed by the CA (verify chain)", () => {
    const ctx = makeIssuerContext();
    const output = flow.onMessage(makeValidRequest("nonce-verify-chain"), ctx);
    const resp = JSON.parse(output[0].payload as string);
    const deviceCert = new crypto.X509Certificate(
      Buffer.from(resp.cert_der, "base64"),
    );
    const caCert = new crypto.X509Certificate(
      Buffer.from(resp.ca_cert_der, "base64"),
    );
    expect(deviceCert.verify(caCert.publicKey)).toBe(true);
  });

  test("cert_validity_days controls notAfter", () => {
    const ctx = makeIssuerContext({ cert_validity_days: 30 });
    const before = Date.now();
    const cert = parseCertFromOutput(
      flow.onMessage(makeValidRequest("nonce-validity"), ctx),
    );
    const after = Date.now();
    const notAfter = new Date(cert.validTo).getTime();
    const expected = before + 30 * 86_400_000;
    // Allow ±5 seconds for clock drift in test
    expect(Math.abs(notAfter - expected)).toBeLessThan(5_000);
  });

  test("custom output_cert_topic_prefix is used", () => {
    const ctx = makeIssuerContext({ output_cert_topic_prefix: "my/certs" });
    const output = flow.onMessage(makeValidRequest("nonce-topic"), ctx);
    expect(output[0].topic).toBe(`my/certs/${DEVICE_ID}`);
  });

  test("two requests with different nonces both succeed", () => {
    const ctx = makeIssuerContext();
    const out1 = flow.onMessage(makeValidRequest("nonce-seq-1"), ctx);
    const out2 = flow.onMessage(makeValidRequest("nonce-seq-2"), ctx);
    expect(out1[0].topic).toBe(`te/pki/x509/cert/issued/${DEVICE_ID}`);
    expect(out2[0].topic).toBe(`te/pki/x509/cert/issued/${DEVICE_ID}`);
  });
});

// ---------------------------------------------------------------------------
// Multiple factory CAs
// ---------------------------------------------------------------------------

describe("multiple factory CAs", () => {
  function dualCAContext() {
    return makeIssuerContext({
      factory_ca_public_keys: JSON.stringify([FACTORY_CA_PUB, FACTORY_CA2_PUB]),
    });
  }

  test("cert from factory CA 1 is accepted", () => {
    const output = flow.onMessage(
      makeValidRequest("multi-ca-1"),
      dualCAContext(),
    );
    expect(output[0].topic).toBe(`te/pki/x509/cert/issued/${DEVICE_ID}`);
  });

  test("cert from factory CA 2 is accepted", () => {
    const cert2 = makeFactoryCert(DEVICE_ID, FACTORY_DEV_PUB, FACTORY_CA2_PRIV);
    const sig2 = makeReqSig(DEVICE_ID, "multi-ca-2", OP_PUB, FACTORY_DEV_PRIV);
    const req = makeRequest({
      nonce: "multi-ca-2",
      factory_cert: cert2,
      req_sig: sig2,
    });
    const output = flow.onMessage(req, dualCAContext());
    expect(output[0].topic).toBe(`te/pki/x509/cert/issued/${DEVICE_ID}`);
  });

  test("cert from unknown CA is rejected", () => {
    const roguePrivBytes = ed25519.utils.randomSecretKey();
    const rogueCert = makeFactoryCert(
      DEVICE_ID,
      FACTORY_DEV_PUB,
      bytesToHex(roguePrivBytes),
    );
    const sig = makeReqSig(
      DEVICE_ID,
      "multi-ca-rogue",
      OP_PUB,
      FACTORY_DEV_PRIV,
    );
    const req = makeRequest({
      nonce: "multi-ca-rogue",
      factory_cert: rogueCert,
      req_sig: sig,
    });
    const output = flow.onMessage(req, dualCAContext());
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });
});

// ---------------------------------------------------------------------------
// Rejection — missing / invalid fields
// ---------------------------------------------------------------------------

describe("rejection — missing fields", () => {
  test("missing _factory_cert → rejected", () => {
    const sig = makeReqSig(
      DEVICE_ID,
      "n-missing-cert",
      OP_PUB,
      FACTORY_DEV_PRIV,
    );
    const req = makeRequest({ nonce: "n-missing-cert", req_sig: sig });
    const output = flow.onMessage(req, makeIssuerContext());
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("missing _req_sig → rejected", () => {
    const factoryCert = makeFactoryCert(
      DEVICE_ID,
      FACTORY_DEV_PUB,
      FACTORY_CA_PRIV,
    );
    const req = makeRequest({
      nonce: "n-missing-sig",
      factory_cert: factoryCert,
    });
    const output = flow.onMessage(req, makeIssuerContext());
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("missing public_key → rejected", () => {
    const msg: tedge.Message = {
      time: new Date(),
      topic: "te/pki/x509/csr",
      payload: JSON.stringify({ device_id: DEVICE_ID, nonce: "n-no-pubkey" }),
    };
    const output = flow.onMessage(msg, makeIssuerContext());
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });
});

describe("rejection — certificate validation", () => {
  test("expired factory cert → rejected", () => {
    const expiredCert = makeFactoryCert(
      DEVICE_ID,
      FACTORY_DEV_PUB,
      FACTORY_CA_PRIV,
      "2020-01-01T00:00:00Z",
    );
    const sig = makeReqSig(DEVICE_ID, "n-expired", OP_PUB, FACTORY_DEV_PRIV);
    const req = makeRequest({
      nonce: "n-expired",
      factory_cert: expiredCert,
      req_sig: sig,
    });
    const output = flow.onMessage(req, makeIssuerContext());
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("future expiry on factory cert is accepted", () => {
    const futureCert = makeFactoryCert(
      DEVICE_ID,
      FACTORY_DEV_PUB,
      FACTORY_CA_PRIV,
      "2099-01-01T00:00:00Z",
    );
    const sig = makeReqSig(DEVICE_ID, "n-future", OP_PUB, FACTORY_DEV_PRIV);
    const req = makeRequest({
      nonce: "n-future",
      factory_cert: futureCert,
      req_sig: sig,
    });
    const output = flow.onMessage(req, makeIssuerContext());
    expect(output[0].topic).toBe(`te/pki/x509/cert/issued/${DEVICE_ID}`);
  });

  test("device_id mismatch between factory cert and request → rejected", () => {
    const certForOther = makeFactoryCert(
      "other-device",
      FACTORY_DEV_PUB,
      FACTORY_CA_PRIV,
    );
    const sig = makeReqSig(
      DEVICE_ID,
      "n-id-mismatch",
      OP_PUB,
      FACTORY_DEV_PRIV,
    );
    const req = makeRequest({
      nonce: "n-id-mismatch",
      factory_cert: certForOther,
      req_sig: sig,
    });
    const output = flow.onMessage(req, makeIssuerContext());
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("tampered factory cert body → rejected", () => {
    const orig = makeFactoryCert(DEVICE_ID, FACTORY_DEV_PUB, FACTORY_CA_PRIV);
    const certJson = new TextDecoder().decode(Buffer.from(orig, "base64"));
    const cert = JSON.parse(certJson);
    cert.device_id = "evil-device";
    const tampered = uint8ToBase64(
      new TextEncoder().encode(JSON.stringify(cert)),
    );
    const sig = makeReqSig("evil-device", "n-tamper", OP_PUB, FACTORY_DEV_PRIV);
    const req = makeRequest({
      device_id: "evil-device",
      nonce: "n-tamper",
      factory_cert: tampered,
      req_sig: sig,
    });
    const output = flow.onMessage(req, makeIssuerContext());
    expect(output[0].topic).toBe("te/pki/x509/req/rejected/evil-device");
  });
});

describe("rejection — request signature", () => {
  test("request signed with wrong key → rejected", () => {
    const wrongPrivBytes = ed25519.utils.randomSecretKey();
    const factoryCert = makeFactoryCert(
      DEVICE_ID,
      FACTORY_DEV_PUB,
      FACTORY_CA_PRIV,
    );
    const sig = makeReqSig(
      DEVICE_ID,
      "n-wrongkey",
      OP_PUB,
      bytesToHex(wrongPrivBytes),
    );
    const req = makeRequest({
      nonce: "n-wrongkey",
      factory_cert: factoryCert,
      req_sig: sig,
    });
    const output = flow.onMessage(req, makeIssuerContext());
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("tampered public_key in request after signing → rejected", () => {
    const factoryCert = makeFactoryCert(
      DEVICE_ID,
      FACTORY_DEV_PUB,
      FACTORY_CA_PRIV,
    );
    const sig = makeReqSig(DEVICE_ID, "n-pub-tamper", OP_PUB, FACTORY_DEV_PRIV);
    const rogueKey = uint8ToBase64(
      ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
    );
    const req = makeRequest({
      nonce: "n-pub-tamper",
      public_key: rogueKey,
      factory_cert: factoryCert,
      req_sig: sig,
    });
    const output = flow.onMessage(req, makeIssuerContext());
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });
});

// ---------------------------------------------------------------------------
// Anti-replay
// ---------------------------------------------------------------------------

describe("anti-replay nonce protection", () => {
  test("same nonce in same context → second request rejected", () => {
    const ctx = makeIssuerContext();
    const opKey2 = uint8ToBase64(
      ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
    );
    const out1 = flow.onMessage(makeValidRequest("replay-nonce"), ctx);
    const out2 = flow.onMessage(makeValidRequest("replay-nonce"), ctx);
    expect(out1[0].topic).toBe(`te/pki/x509/cert/issued/${DEVICE_ID}`);
    expect(out2[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });
});

// ---------------------------------------------------------------------------
// Configuration errors
// ---------------------------------------------------------------------------

describe("configuration errors", () => {
  test("missing ca_private_key → rejected", () => {
    const ctx = tedge.createContext({
      ca_cert_der: CA_CERT_DER_B64,
      factory_ca_public_keys: JSON.stringify([FACTORY_CA_PUB]),
    });
    const output = flow.onMessage(makeValidRequest("n-no-priv"), ctx);
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("missing ca_cert_der → rejected", () => {
    const ctx = tedge.createContext({
      ca_private_key: CA_PRIV_B64,
      factory_ca_public_keys: JSON.stringify([FACTORY_CA_PUB]),
    });
    const output = flow.onMessage(makeValidRequest("n-no-der"), ctx);
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("empty factory_ca_public_keys → rejected", () => {
    const ctx = makeIssuerContext({ factory_ca_public_keys: "[]" });
    const output = flow.onMessage(makeValidRequest("n-empty-ca"), ctx);
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("rejected message discarded when output_rejected_topic empty", () => {
    const ctx = makeIssuerContext({ output_rejected_topic: "" });
    const msg: tedge.Message = {
      time: new Date(),
      topic: "te/pki/x509/csr",
      payload: JSON.stringify({ device_id: DEVICE_ID }),
    };
    const output = flow.onMessage(msg, ctx);
    expect(output).toHaveLength(0);
  });

  test("denied device_id → CSR rejected", () => {
    const ctx = makeIssuerContext({
      denied_device_ids: JSON.stringify([DEVICE_ID]),
    });
    const output = flow.onMessage(makeValidRequest("n-deny-csr"), ctx);
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
    expect(JSON.parse(output[0].payload as string)._rejection_reason).toMatch(
      /denied/,
    );
  });

  test("denied device_id → renewal rejected", () => {
    const ctx = makeIssuerContext({ require_factory_cert: false });
    const certDerB64 = issueInitialCert(ctx, "n-deny-renew-init");
    const denyCtx = makeIssuerContext({
      require_factory_cert: false,
      denied_device_ids: JSON.stringify([DEVICE_ID]),
    });
    const sig = makeRenewalReqSig(DEVICE_ID, "n-deny-renew", OP_PUB, OP_PRIV);
    const output = flow.onMessage(
      makeRenewalRequest({
        nonce: "n-deny-renew",
        current_cert_der_b64: certDerB64,
        req_sig: sig,
      }),
      denyCtx,
    );
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
    expect(JSON.parse(output[0].payload as string)._rejection_reason).toMatch(
      /denied/,
    );
  });

  test("non-denied device_id is still accepted", () => {
    const ctx = makeIssuerContext({
      denied_device_ids: JSON.stringify(["some-other-device"]),
    });
    const output = flow.onMessage(makeValidRequest("n-deny-other"), ctx);
    expect(output[0].topic).toMatch(/^te\/pki\/x509\/cert\/issued\//);
  });

  test("invalid denied_device_ids JSON → rejected", () => {
    const ctx = makeIssuerContext({ denied_device_ids: "not-json" });
    const output = flow.onMessage(makeValidRequest("n-deny-bad-json"), ctx);
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });
});

// ---------------------------------------------------------------------------
// revoked_cert_serials (CRL-style serial revocation)
// ---------------------------------------------------------------------------

describe("revoked_cert_serials", () => {
  function openContext(extra: Record<string, unknown> = {}) {
    return makeIssuerContext({ require_factory_cert: false, ...extra });
  }

  /** Extract the hex serial from an issued cert response payload. */
  function certSerialFromOutput(output: tedge.Message[]): string {
    const resp = JSON.parse(output[0].payload as string);
    expect(resp.cert_serial).toBeDefined();
    return resp.cert_serial as string;
  }

  test("issuance response includes cert_serial", () => {
    const ctx = openContext();
    const output = flow.onMessage(makeValidRequest("serial-in-resp"), ctx);
    expect(output).toHaveLength(1);
    expect(output[0].topic).toMatch(/^te\/pki\/x509\/cert\/issued\//);
    const resp = JSON.parse(output[0].payload as string);
    expect(typeof resp.cert_serial).toBe("string");
    expect(resp.cert_serial.length).toBeGreaterThan(0);
    expect(resp.cert_serial).toMatch(/^[0-9a-f]+$/);
  });

  test("renewal of a revoked serial is rejected", () => {
    const ctx = openContext();
    // Issue an initial certificate and record its serial.
    const initOutput = flow.onMessage(makeValidRequest("serial-rev-init"), ctx);
    const serial = certSerialFromOutput(initOutput);
    const certDerB64 = JSON.parse(initOutput[0].payload as string)
      .cert_der as string;

    // Now add that serial to the revoked list.
    const revokedCtx = openContext({
      revoked_cert_serials: JSON.stringify([serial]),
    });
    const sig = makeRenewalReqSig(
      DEVICE_ID,
      "serial-rev-renew",
      OP_PUB,
      OP_PRIV,
    );
    const output = flow.onMessage(
      makeRenewalRequest({
        nonce: "serial-rev-renew",
        current_cert_der_b64: certDerB64,
        req_sig: sig,
      }),
      revokedCtx,
    );
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
    expect(JSON.parse(output[0].payload as string)._rejection_reason).toMatch(
      /revoked/,
    );
  });

  test("re-enrollment after revocation succeeds (new factory cert request gets fresh serial)", () => {
    const ctx = openContext();
    const initOutput = flow.onMessage(
      makeValidRequest("serial-reenroll-init"),
      ctx,
    );
    const revokedSerial = certSerialFromOutput(initOutput);

    // Revoke that serial, but re-enrollment (new CSR) must still be accepted.
    const revokedCtx = openContext({
      revoked_cert_serials: JSON.stringify([revokedSerial]),
    });
    const newOutput = flow.onMessage(
      makeValidRequest("serial-reenroll-new"),
      revokedCtx,
    );
    expect(newOutput[0].topic).toMatch(/^te\/pki\/x509\/cert\/issued\//);
    const newSerial = certSerialFromOutput(newOutput);
    expect(newSerial).not.toBe(revokedSerial);
  });

  test("revoked serial does not block a different device's renewal", () => {
    const ctx = openContext();
    const initOutput = flow.onMessage(
      makeValidRequest("serial-crossdev-init"),
      ctx,
    );
    const serial = certSerialFromOutput(initOutput);
    const certDerB64 = JSON.parse(initOutput[0].payload as string)
      .cert_der as string;

    // Second cert for the same device — different serial.
    const initOutput2 = flow.onMessage(
      makeValidRequest("serial-crossdev-init2"),
      ctx,
    );
    const serial2 = certSerialFromOutput(initOutput2);
    const certDerB642 = JSON.parse(initOutput2[0].payload as string)
      .cert_der as string;

    // Only revoke the first serial.
    const revokedCtx = openContext({
      revoked_cert_serials: JSON.stringify([serial]),
    });
    // Renewal using cert2 (different serial, not revoked) must succeed.
    const sig = makeRenewalReqSig(
      DEVICE_ID,
      "serial-crossdev-renew2",
      OP_PUB,
      OP_PRIV,
    );
    const output = flow.onMessage(
      makeRenewalRequest({
        nonce: "serial-crossdev-renew2",
        current_cert_der_b64: certDerB642,
        req_sig: sig,
      }),
      revokedCtx,
    );
    expect(output[0].topic).toMatch(/^te\/pki\/x509\/cert\/issued\//);
  });

  test("invalid revoked_cert_serials JSON → rejected", () => {
    const ctx = openContext({ revoked_cert_serials: "not-json" });
    const output = flow.onMessage(makeValidRequest("serial-bad-json"), ctx);
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });
});

// ---------------------------------------------------------------------------
// denied_factory_pubkeys (factory credential revocation)
// ---------------------------------------------------------------------------

describe("denied_factory_pubkeys", () => {
  test("CSR with a denied factory pubkey is rejected", () => {
    // Deny the specific factory device public key used in makeValidRequest.
    const ctx = makeIssuerContext({
      denied_factory_pubkeys: JSON.stringify([FACTORY_DEV_PUB]),
    });
    const output = flow.onMessage(makeValidRequest("deny-fpub-csr"), ctx);
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
    expect(JSON.parse(output[0].payload as string)._rejection_reason).toMatch(
      /revoked/,
    );
  });

  test("CSR with a different (non-denied) factory pubkey is accepted", () => {
    // Create a second factory device key pair.
    const otherDevPrivBytes = ed25519.utils.randomSecretKey();
    const otherDevPriv = bytesToHex(otherDevPrivBytes);
    const otherDevPub = uint8ToBase64(ed25519.getPublicKey(otherDevPrivBytes));
    const otherOpPrivBytes = ed25519.utils.randomSecretKey();
    const otherOpPub = uint8ToBase64(ed25519.getPublicKey(otherOpPrivBytes));

    // Only deny the default factory dev key, not the other one.
    const ctx = makeIssuerContext({
      denied_factory_pubkeys: JSON.stringify([FACTORY_DEV_PUB]),
    });
    const factoryCert = makeFactoryCert(
      DEVICE_ID,
      otherDevPub,
      FACTORY_CA_PRIV,
    );
    const reqSig = makeReqSig(
      DEVICE_ID,
      "deny-fpub-other",
      otherOpPub,
      otherDevPriv,
    );
    const msg: tedge.Message = {
      time: new Date(),
      topic: "te/pki/x509/csr",
      payload: JSON.stringify({
        device_id: DEVICE_ID,
        public_key: otherOpPub,
        nonce: "deny-fpub-other",
        _factory_cert: factoryCert,
        _req_sig: reqSig,
      }),
    };
    const output = flow.onMessage(msg, ctx);
    expect(output[0].topic).toMatch(/^te\/pki\/x509\/cert\/issued\//);
  });

  test("invalid denied_factory_pubkeys JSON → rejected", () => {
    const ctx = makeIssuerContext({ denied_factory_pubkeys: "not-json" });
    const output = flow.onMessage(makeValidRequest("deny-fpub-bad-json"), ctx);
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });
});

// ---------------------------------------------------------------------------
// require_factory_cert = false
// ---------------------------------------------------------------------------

describe("require_factory_cert = false", () => {
  function openContext(extra: Record<string, unknown> = {}) {
    return makeIssuerContext({ require_factory_cert: false, ...extra });
  }

  test("CSR without _factory_cert or _req_sig is accepted", () => {
    const ctx = openContext();
    const msg: tedge.Message = {
      time: new Date(),
      topic: "te/pki/x509/csr",
      payload: JSON.stringify({
        device_id: DEVICE_ID,
        public_key: OP_PUB,
        nonce: "open-nonce-1",
      }),
    };
    const output = flow.onMessage(msg, ctx);
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe(`te/pki/x509/cert/issued/${DEVICE_ID}`);
  });

  test("issued cert is valid and signed by CA", () => {
    const ctx = openContext();
    const msg: tedge.Message = {
      time: new Date(),
      topic: "te/pki/x509/csr",
      payload: JSON.stringify({
        device_id: DEVICE_ID,
        public_key: OP_PUB,
        nonce: "open-nonce-2",
      }),
    };
    const output = flow.onMessage(msg, ctx);
    const resp = JSON.parse(output[0].payload as string);
    const deviceCert = new crypto.X509Certificate(
      Buffer.from(resp.cert_der, "base64"),
    );
    const caCert = new crypto.X509Certificate(
      Buffer.from(resp.ca_cert_der, "base64"),
    );
    expect(deviceCert.verify(caCert.publicKey)).toBe(true);
  });

  test("nonce replay is still rejected even without factory cert", () => {
    const ctx = openContext();
    const msg = (n: string): tedge.Message => ({
      time: new Date(),
      topic: "te/pki/x509/csr",
      payload: JSON.stringify({
        device_id: DEVICE_ID,
        public_key: OP_PUB,
        nonce: n,
      }),
    });
    flow.onMessage(msg("open-replay"), ctx);
    const out2 = flow.onMessage(msg("open-replay"), ctx);
    expect(out2[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("missing public_key is still rejected", () => {
    const ctx = openContext();
    const msg: tedge.Message = {
      time: new Date(),
      topic: "te/pki/x509/csr",
      payload: JSON.stringify({ device_id: DEVICE_ID, nonce: "open-no-pub" }),
    };
    const output = flow.onMessage(msg, ctx);
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("empty factory_ca_public_keys does not block when require_factory_cert=false", () => {
    const ctx = tedge.createContext({
      ca_private_key: CA_PRIV_B64,
      ca_cert_der: CA_CERT_DER_B64,
      factory_ca_public_keys: "[]",
      require_factory_cert: false,
    });
    const msg: tedge.Message = {
      time: new Date(),
      topic: "te/pki/x509/csr",
      payload: JSON.stringify({
        device_id: DEVICE_ID,
        public_key: OP_PUB,
        nonce: "open-empty-ca",
      }),
    };
    const output = flow.onMessage(msg, ctx);
    expect(output[0].topic).toBe(`te/pki/x509/cert/issued/${DEVICE_ID}`);
  });
});

// ---------------------------------------------------------------------------
// Server-side key generation (keygen topic)
// ---------------------------------------------------------------------------

function makeKeygenReqSig(
  deviceId: string,
  nonce: string,
  factoryPrivHex: string,
): string {
  const body = { device_id: deviceId, nonce };
  const encoder = new TextEncoder();
  const canonical = JSON.stringify(body, Object.keys(body).sort());
  const sig = ed25519.sign(
    encoder.encode(canonical),
    hexToBytes(factoryPrivHex),
  );
  return uint8ToBase64(sig);
}

describe("server-side key generation", () => {
  function makeKeygenRequest(
    opts: { nonce?: string; factory?: boolean } = {},
  ): tedge.Message {
    const nonce = opts.nonce ?? "keygen-nonce-1";
    const payload: Record<string, string> = { device_id: DEVICE_ID, nonce };
    if (opts.factory !== false) {
      payload._factory_cert = makeFactoryCert(
        DEVICE_ID,
        FACTORY_DEV_PUB,
        FACTORY_CA_PRIV,
      );
      payload._req_sig = makeKeygenReqSig(DEVICE_ID, nonce, FACTORY_DEV_PRIV);
    }
    return {
      time: new Date(),
      topic: "te/pki/x509/keygen",
      payload: JSON.stringify(payload),
    };
  }

  test("keygen response contains private_key_der, cert_der, ca_cert_der, device_id", () => {
    const ctx = makeIssuerContext();
    const output = flow.onMessage(
      makeKeygenRequest({ nonce: "kg-fields" }),
      ctx,
    );
    expect(output).toHaveLength(1);
    const resp = JSON.parse(output[0].payload as string);
    expect(resp.device_id).toBe(DEVICE_ID);
    expect(resp.private_key_der).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(resp.private_key_der, "base64")).toHaveLength(48); // PKCS#8 Ed25519 = 48 bytes
    expect(resp.cert_der).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(resp.ca_cert_der).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  test("keygen response is on the keygen issued topic", () => {
    const ctx = makeIssuerContext();
    const output = flow.onMessage(
      makeKeygenRequest({ nonce: "kg-topic" }),
      ctx,
    );
    expect(output[0].topic).toBe(`te/pki/x509/keygen/issued/${DEVICE_ID}`);
  });

  test("generated cert is valid and signed by CA", () => {
    const ctx = makeIssuerContext();
    const output = flow.onMessage(
      makeKeygenRequest({ nonce: "kg-chain" }),
      ctx,
    );
    const resp = JSON.parse(output[0].payload as string);
    const deviceCert = new crypto.X509Certificate(
      Buffer.from(resp.cert_der, "base64"),
    );
    const caCert = new crypto.X509Certificate(
      Buffer.from(resp.ca_cert_der, "base64"),
    );
    expect(deviceCert.verify(caCert.publicKey)).toBe(true);
  });

  test("generated private key matches the public key in the cert", () => {
    const ctx = makeIssuerContext();
    const output = flow.onMessage(
      makeKeygenRequest({ nonce: "kg-keypair" }),
      ctx,
    );
    const resp = JSON.parse(output[0].payload as string);
    const deviceCert = new crypto.X509Certificate(
      Buffer.from(resp.cert_der, "base64"),
    );

    // Re-derive public key from the returned private key (last 32 bytes of PKCS#8 DER)
    const privBytes = Buffer.from(resp.private_key_der, "base64").slice(-32);
    const derivedPub = ed25519.getPublicKey(new Uint8Array(privBytes));

    // Extract raw public key from cert (last 32 bytes of SubjectPublicKeyInfo)
    const certPubKeyDer = deviceCert.publicKey.export({
      type: "spki",
      format: "der",
    }) as Buffer;
    const certPubKeyBytes = certPubKeyDer.slice(-32);

    expect(Buffer.from(derivedPub).equals(certPubKeyBytes)).toBe(true);
  });

  test("keygen without factory cert is rejected when require_factory_cert=true (default)", () => {
    const ctx = makeIssuerContext();
    const output = flow.onMessage(
      makeKeygenRequest({ nonce: "kg-no-cert", factory: false }),
      ctx,
    );
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("keygen without factory cert accepted when require_factory_cert=false", () => {
    const ctx = makeIssuerContext({ require_factory_cert: false });
    const msg: tedge.Message = {
      time: new Date(),
      topic: "te/pki/x509/keygen",
      payload: JSON.stringify({ device_id: DEVICE_ID, nonce: "kg-open" }),
    };
    const output = flow.onMessage(msg, ctx);
    expect(output[0].topic).toBe(`te/pki/x509/keygen/issued/${DEVICE_ID}`);
    const resp = JSON.parse(output[0].payload as string);
    expect(resp.private_key_der).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  test("keygen nonce replay is rejected", () => {
    const ctx = makeIssuerContext();
    flow.onMessage(makeKeygenRequest({ nonce: "kg-replay" }), ctx);
    const out2 = flow.onMessage(makeKeygenRequest({ nonce: "kg-replay" }), ctx);
    expect(out2[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("custom output_keygen_topic_prefix is used", () => {
    const ctx = makeIssuerContext({ output_keygen_topic_prefix: "my/keygen" });
    const output = flow.onMessage(
      makeKeygenRequest({ nonce: "kg-custom-topic" }),
      ctx,
    );
    expect(output[0].topic).toBe(`my/keygen/${DEVICE_ID}`);
  });
});

// ---------------------------------------------------------------------------
// Issuer/subject Name byte identity — required for openssl verify to succeed
// ---------------------------------------------------------------------------

describe("issuer Name DER bytes match CA subject Name DER bytes", () => {
  function toCertPEM(der: Buffer): string {
    return (
      "-----BEGIN CERTIFICATE-----\n" +
      der
        .toString("base64")
        .match(/.{1,64}/g)!
        .join("\n") +
      "\n-----END CERTIFICATE-----\n"
    );
  }

  test("CSR mode: issuer Name bytes are byte-for-byte identical to CA subject Name bytes", () => {
    const ctx = makeIssuerContext();
    const output = flow.onMessage(makeValidRequest("nonce-namebytes-csr"), ctx);
    const resp = JSON.parse(output[0].payload as string);

    const issuerBytes = extractIssuerNameDer(
      Buffer.from(resp.cert_der, "base64"),
    );
    const subjectBytes = extractSubjectNameDer(
      Buffer.from(resp.ca_cert_der, "base64"),
    );

    expect(issuerBytes.equals(subjectBytes)).toBe(true);
  });

  test("keygen mode: issuer Name bytes are byte-for-byte identical to CA subject Name bytes", () => {
    const ctx = makeIssuerContext();
    const nonce = "nonce-namebytes-kg";
    const msg: tedge.Message = {
      time: new Date(),
      topic: "te/pki/x509/keygen",
      payload: JSON.stringify({
        device_id: DEVICE_ID,
        nonce,
        _factory_cert: makeFactoryCert(
          DEVICE_ID,
          FACTORY_DEV_PUB,
          FACTORY_CA_PRIV,
        ),
        _req_sig: makeKeygenReqSig(DEVICE_ID, nonce, FACTORY_DEV_PRIV),
      }),
    };
    const output = flow.onMessage(msg, ctx);
    const resp = JSON.parse(output[0].payload as string);

    const issuerBytes = extractIssuerNameDer(
      Buffer.from(resp.cert_der, "base64"),
    );
    const subjectBytes = extractSubjectNameDer(
      Buffer.from(resp.ca_cert_der, "base64"),
    );

    expect(issuerBytes.equals(subjectBytes)).toBe(true);
  });

  test("CSR mode: openssl verify -CAfile passes", () => {
    const { spawnSync } = require("child_process");
    const fs = require("fs");
    const os = require("os");
    const path = require("path");

    const ctx = makeIssuerContext();
    const output = flow.onMessage(
      makeValidRequest("nonce-osslverify-csr"),
      ctx,
    );
    const resp = JSON.parse(output[0].payload as string);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jest-x509-csr-"));
    try {
      const tmpCA = path.join(tmpDir, "ca.pem");
      const tmpDev = path.join(tmpDir, "dev.pem");
      fs.writeFileSync(tmpCA, CA_CERT_PEM);
      fs.writeFileSync(tmpDev, toCertPEM(Buffer.from(resp.cert_der, "base64")));
      const result = spawnSync(
        "openssl",
        ["verify", "-CAfile", tmpCA, tmpDev],
        { stdio: "pipe" },
      );
      if (result.status !== 0)
        throw new Error(
          `openssl verify failed: ${result.stdout?.toString()}${result.stderr?.toString()}`,
        );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test("keygen mode: openssl verify -CAfile passes", () => {
    const { spawnSync } = require("child_process");
    const fs = require("fs");
    const os = require("os");
    const path = require("path");

    const nonce = "nonce-osslverify-kg";
    const ctx = makeIssuerContext();
    const msg: tedge.Message = {
      time: new Date(),
      topic: "te/pki/x509/keygen",
      payload: JSON.stringify({
        device_id: DEVICE_ID,
        nonce,
        _factory_cert: makeFactoryCert(
          DEVICE_ID,
          FACTORY_DEV_PUB,
          FACTORY_CA_PRIV,
        ),
        _req_sig: makeKeygenReqSig(DEVICE_ID, nonce, FACTORY_DEV_PRIV),
      }),
    };
    const output = flow.onMessage(msg, ctx);
    const resp = JSON.parse(output[0].payload as string);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jest-x509-kg-"));
    try {
      const tmpCA = path.join(tmpDir, "ca.pem");
      const tmpDev = path.join(tmpDir, "dev.pem");
      fs.writeFileSync(tmpCA, CA_CERT_PEM);
      fs.writeFileSync(tmpDev, toCertPEM(Buffer.from(resp.cert_der, "base64")));
      const result = spawnSync(
        "openssl",
        ["verify", "-CAfile", tmpCA, tmpDev],
        { stdio: "pipe" },
      );
      if (result.status !== 0)
        throw new Error(
          `openssl verify failed: ${result.stdout?.toString()}${result.stderr?.toString()}`,
        );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Certificate renewal
// ---------------------------------------------------------------------------

/** Sign a renewal request with the CURRENT operational private key. */
function makeRenewalReqSig(
  deviceId: string,
  nonce: string,
  newPublicKey: string,
  currentPrivHex: string,
): string {
  const body = { device_id: deviceId, nonce, public_key: newPublicKey };
  const encoder = new TextEncoder();
  const canonical = JSON.stringify(body, Object.keys(body).sort());
  const sig = ed25519.sign(
    encoder.encode(canonical),
    hexToBytes(currentPrivHex),
  );
  return uint8ToBase64(sig);
}

function makeRenewalRequest(opts: {
  device_id?: string;
  new_public_key?: string;
  nonce?: string;
  current_cert_der_b64?: string;
  req_sig?: string;
}): tedge.Message {
  return {
    time: new Date(),
    topic: "te/pki/x509/renew",
    payload: JSON.stringify({
      device_id: opts.device_id ?? DEVICE_ID,
      public_key: opts.new_public_key ?? OP_PUB,
      nonce: opts.nonce ?? "renew-nonce",
      _current_cert: opts.current_cert_der_b64,
      _req_sig: opts.req_sig,
    }),
  };
}

/**
 * Issue a cert via the normal CSR flow and return its base64 DER.
 * Uses a fresh context so nonces don't collide with the calling test's context.
 */
function issueInitialCert(
  ctx: ReturnType<typeof makeIssuerContext>,
  nonce: string,
  opPub = OP_PUB,
): string {
  const output = flow.onMessage(makeValidRequest(nonce, opPub), ctx);
  if (!output[0] || !output[0].topic.startsWith("te/pki/x509/cert/issued/")) {
    throw new Error(`initial cert issuance failed: ${output[0]?.topic}`);
  }
  return JSON.parse(output[0].payload as string).cert_der as string;
}

describe("certificate renewal", () => {
  test("valid renewal with same key is accepted and returns a cert on the issued topic", () => {
    const ctx = makeIssuerContext();
    const certDerB64 = issueInitialCert(ctx, "renew-init-1");
    const sig = makeRenewalReqSig(DEVICE_ID, "renew-1", OP_PUB, OP_PRIV);
    const output = flow.onMessage(
      makeRenewalRequest({
        nonce: "renew-1",
        current_cert_der_b64: certDerB64,
        req_sig: sig,
      }),
      ctx,
    );
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe(`te/pki/x509/cert/issued/${DEVICE_ID}`);
  });

  test("renewal response contains cert_der, ca_cert_der, and device_id", () => {
    const ctx = makeIssuerContext();
    const certDerB64 = issueInitialCert(ctx, "renew-init-fields");
    const sig = makeRenewalReqSig(DEVICE_ID, "renew-fields", OP_PUB, OP_PRIV);
    const output = flow.onMessage(
      makeRenewalRequest({
        nonce: "renew-fields",
        current_cert_der_b64: certDerB64,
        req_sig: sig,
      }),
      ctx,
    );
    const resp = JSON.parse(output[0].payload as string);
    expect(resp.device_id).toBe(DEVICE_ID);
    expect(resp.cert_der).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(resp.ca_cert_der).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  test("renewed cert is signed by the CA", () => {
    const ctx = makeIssuerContext();
    const certDerB64 = issueInitialCert(ctx, "renew-init-chain");
    const sig = makeRenewalReqSig(DEVICE_ID, "renew-chain", OP_PUB, OP_PRIV);
    const output = flow.onMessage(
      makeRenewalRequest({
        nonce: "renew-chain",
        current_cert_der_b64: certDerB64,
        req_sig: sig,
      }),
      ctx,
    );
    const resp = JSON.parse(output[0].payload as string);
    const renewedCert = new crypto.X509Certificate(
      Buffer.from(resp.cert_der, "base64"),
    );
    const caCert = new crypto.X509Certificate(
      Buffer.from(resp.ca_cert_der, "base64"),
    );
    expect(renewedCert.verify(caCert.publicKey)).toBe(true);
  });

  test("renewal with a new key issues a cert for the new key", () => {
    const ctx = makeIssuerContext();
    const certDerB64 = issueInitialCert(ctx, "renew-init-newkey");
    const newPrivBytes = ed25519.utils.randomSecretKey();
    const newPub = uint8ToBase64(ed25519.getPublicKey(newPrivBytes));
    const sig = makeRenewalReqSig(DEVICE_ID, "renew-newkey", newPub, OP_PRIV);
    const output = flow.onMessage(
      makeRenewalRequest({
        nonce: "renew-newkey",
        new_public_key: newPub,
        current_cert_der_b64: certDerB64,
        req_sig: sig,
      }),
      ctx,
    );
    expect(output[0].topic).toBe(`te/pki/x509/cert/issued/${DEVICE_ID}`);
    const renewedCert = parseCertFromOutput(output);
    // The renewed cert subject should still be the device
    expect(renewedCert.subject).toMatch(/CN\s*=\s*my-device-001/);
  });

  test("custom output_renewal_topic_prefix is used", () => {
    const ctx = makeIssuerContext({
      output_renewal_topic_prefix: "my/renewals",
    });
    const certDerB64 = issueInitialCert(ctx, "renew-init-topic");
    const sig = makeRenewalReqSig(DEVICE_ID, "renew-topic", OP_PUB, OP_PRIV);
    const output = flow.onMessage(
      makeRenewalRequest({
        nonce: "renew-topic",
        current_cert_der_b64: certDerB64,
        req_sig: sig,
      }),
      ctx,
    );
    expect(output[0].topic).toBe(`my/renewals/${DEVICE_ID}`);
  });

  test("missing _current_cert is rejected", () => {
    const ctx = makeIssuerContext();
    const sig = makeRenewalReqSig(DEVICE_ID, "renew-no-curr", OP_PUB, OP_PRIV);
    const output = flow.onMessage(
      makeRenewalRequest({ nonce: "renew-no-curr", req_sig: sig }),
      ctx,
    );
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("missing _req_sig is rejected", () => {
    const ctx = makeIssuerContext();
    const certDerB64 = issueInitialCert(ctx, "renew-init-nosig");
    const output = flow.onMessage(
      makeRenewalRequest({
        nonce: "renew-nosig",
        current_cert_der_b64: certDerB64,
      }),
      ctx,
    );
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("certificate not issued by this CA is rejected", () => {
    const ctx = makeIssuerContext();
    const certDerB64 = issueInitialCert(ctx, "renew-init-foreign");
    // Corrupt the last byte of the signature to simulate a foreign CA
    const certBytes = Buffer.from(certDerB64, "base64");
    certBytes[certBytes.length - 1] ^= 0xff;
    const corruptedCertDerB64 = certBytes.toString("base64");
    const sig = makeRenewalReqSig(DEVICE_ID, "renew-foreign", OP_PUB, OP_PRIV);
    const output = flow.onMessage(
      makeRenewalRequest({
        nonce: "renew-foreign",
        current_cert_der_b64: corruptedCertDerB64,
        req_sig: sig,
      }),
      ctx,
    );
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("certificate CN mismatch with device_id is rejected", () => {
    // Issue a cert for "other-device" (no factory cert required)
    const ctx = makeIssuerContext({ require_factory_cert: false });
    const otherMsg: tedge.Message = {
      time: new Date(),
      topic: "te/pki/x509/csr",
      payload: JSON.stringify({
        device_id: "other-device",
        public_key: OP_PUB,
        nonce: "cn-mismatch-issue",
      }),
    };
    const issuedResp = JSON.parse(
      flow.onMessage(otherMsg, ctx)[0].payload as string,
    );

    // Try to renew claiming device_id = DEVICE_ID, but the cert's CN = "other-device"
    const sig = makeRenewalReqSig(
      DEVICE_ID,
      "cn-mismatch-renew",
      OP_PUB,
      OP_PRIV,
    );
    const output = flow.onMessage(
      makeRenewalRequest({
        device_id: DEVICE_ID,
        nonce: "cn-mismatch-renew",
        current_cert_der_b64: issuedResp.cert_der,
        req_sig: sig,
      }),
      ctx,
    );
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("request signature signed with wrong key is rejected", () => {
    const ctx = makeIssuerContext();
    const certDerB64 = issueInitialCert(ctx, "renew-init-wrongsig");
    const wrongPriv = bytesToHex(ed25519.utils.randomSecretKey());
    const sig = makeRenewalReqSig(
      DEVICE_ID,
      "renew-wrongsig",
      OP_PUB,
      wrongPriv,
    );
    const output = flow.onMessage(
      makeRenewalRequest({
        nonce: "renew-wrongsig",
        current_cert_der_b64: certDerB64,
        req_sig: sig,
      }),
      ctx,
    );
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("nonce replay in renewal is rejected", () => {
    const ctx = makeIssuerContext();
    const certDerB64 = issueInitialCert(ctx, "renew-init-replay");
    const sig = makeRenewalReqSig(
      DEVICE_ID,
      "renew-replay-nonce",
      OP_PUB,
      OP_PRIV,
    );
    const req = makeRenewalRequest({
      nonce: "renew-replay-nonce",
      current_cert_der_b64: certDerB64,
      req_sig: sig,
    });
    const out1 = flow.onMessage(req, ctx);
    const out2 = flow.onMessage(req, ctx);
    expect(out1[0].topic).toBe(`te/pki/x509/cert/issued/${DEVICE_ID}`);
    expect(out2[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("renewal_window_days rejects cert not close enough to expiry", () => {
    // cert_validity_days=365; renewal_window_days=30 → cert expires in 365 days, window is 30 → rejected
    const ctx = makeIssuerContext({
      cert_validity_days: 365,
      renewal_window_days: 30,
    });
    const certDerB64 = issueInitialCert(ctx, "renew-init-window-far");
    const sig = makeRenewalReqSig(
      DEVICE_ID,
      "renew-window-far",
      OP_PUB,
      OP_PRIV,
    );
    const output = flow.onMessage(
      makeRenewalRequest({
        nonce: "renew-window-far",
        current_cert_der_b64: certDerB64,
        req_sig: sig,
      }),
      ctx,
    );
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("renewal_window_days accepts cert close to expiry", () => {
    // cert_validity_days=10; renewal_window_days=30 → cert expires in 10 days, within 30-day window → accepted
    const ctx = makeIssuerContext({
      cert_validity_days: 10,
      renewal_window_days: 30,
    });
    const certDerB64 = issueInitialCert(ctx, "renew-init-window-close");
    const sig = makeRenewalReqSig(
      DEVICE_ID,
      "renew-window-close",
      OP_PUB,
      OP_PRIV,
    );
    const output = flow.onMessage(
      makeRenewalRequest({
        nonce: "renew-window-close",
        current_cert_der_b64: certDerB64,
        req_sig: sig,
      }),
      ctx,
    );
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe(`te/pki/x509/cert/issued/${DEVICE_ID}`);
  });

  test("require_factory_cert=true does not block renewals", () => {
    // Factory cert verification is required for CSR but should be bypassed for renewal
    const ctx = makeIssuerContext(); // require_factory_cert=true (default)
    const certDerB64 = issueInitialCert(ctx, "renew-init-factorybypass");
    const sig = makeRenewalReqSig(
      DEVICE_ID,
      "renew-factorybypass",
      OP_PUB,
      OP_PRIV,
    );
    const output = flow.onMessage(
      makeRenewalRequest({
        nonce: "renew-factorybypass",
        current_cert_der_b64: certDerB64,
        req_sig: sig,
      }),
      ctx,
    );
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe(`te/pki/x509/cert/issued/${DEVICE_ID}`);
  });
});

// ---------------------------------------------------------------------------
// Subject Alternative Names (SAN)
// ---------------------------------------------------------------------------

/** Extract the subjectAltName extension string from a Node X509Certificate. */
function getSAN(cert: crypto.X509Certificate): string {
  return cert.subjectAltName ?? "";
}

/** Build a CSR-style payload with optional SAN fields (require_factory_cert=false). */
function makeOpenRequest(
  nonce: string,
  extra: Record<string, unknown> = {},
): tedge.Message {
  return {
    time: new Date(),
    topic: "te/pki/x509/csr",
    payload: JSON.stringify({
      device_id: DEVICE_ID,
      public_key: OP_PUB,
      nonce,
      ...extra,
    }),
  };
}

describe("Subject Alternative Names (SAN)", () => {
  test("CSR with san_dns_names produces a cert containing dNSName SANs", () => {
    const ctx = makeIssuerContext({ require_factory_cert: false });
    const msg = makeOpenRequest("san-dns-1", {
      san_dns_names: JSON.stringify(["device.local", "device.example.com"]),
    });
    const cert = parseCertFromOutput(flow.onMessage(msg, ctx));
    const san = getSAN(cert);
    expect(san).toMatch(/DNS:device\.local/);
    expect(san).toMatch(/DNS:device\.example\.com/);
  });

  test("CSR with san_ip_addresses produces a cert containing iPAddress SANs", () => {
    const ctx = makeIssuerContext({ require_factory_cert: false });
    const msg = makeOpenRequest("san-ip-1", {
      san_ip_addresses: JSON.stringify(["192.168.1.42"]),
    });
    const cert = parseCertFromOutput(flow.onMessage(msg, ctx));
    const san = getSAN(cert);
    expect(san).toMatch(/IP Address:192\.168\.1\.42/i);
  });

  test("CSR with both san_dns_names and san_ip_addresses produces both SAN types", () => {
    const ctx = makeIssuerContext({ require_factory_cert: false });
    const msg = makeOpenRequest("san-both-1", {
      san_dns_names: JSON.stringify(["device.local"]),
      san_ip_addresses: JSON.stringify(["10.0.0.5"]),
    });
    const cert = parseCertFromOutput(flow.onMessage(msg, ctx));
    const san = getSAN(cert);
    expect(san).toMatch(/DNS:device\.local/);
    expect(san).toMatch(/IP Address:10\.0\.0\.5/i);
  });

  test("CSR without SAN fields produces a cert with no subjectAltName extension", () => {
    const ctx = makeIssuerContext({ require_factory_cert: false });
    const msg = makeOpenRequest("san-none-1");
    const cert = parseCertFromOutput(flow.onMessage(msg, ctx));
    expect(getSAN(cert)).toBe("");
  });

  test("keygen request with san_dns_names produces a cert containing dNSName SANs", () => {
    const ctx = makeIssuerContext({ require_factory_cert: false });
    const msg: tedge.Message = {
      time: new Date(),
      topic: "te/pki/x509/keygen",
      payload: JSON.stringify({
        device_id: DEVICE_ID,
        nonce: "san-keygen-dns-1",
        san_dns_names: JSON.stringify(["keygen-device.local"]),
      }),
    };
    const cert = parseCertFromOutput(flow.onMessage(msg, ctx));
    expect(getSAN(cert)).toMatch(/DNS:keygen-device\.local/);
  });

  test("CSR with san_dns_names as native JSON array produces dNSName SANs", () => {
    const ctx = makeIssuerContext({ require_factory_cert: false });
    const msg = makeOpenRequest("san-dns-native-1", {
      // Native JSON array (not a JSON-encoded string) — sent by x509-cert.sh
      san_dns_names: ["device.local", "device.example.com"],
    });
    const cert = parseCertFromOutput(flow.onMessage(msg, ctx));
    const san = getSAN(cert);
    expect(san).toMatch(/DNS:device\.local/);
    expect(san).toMatch(/DNS:device\.example\.com/);
  });

  test("CSR with san_ip_addresses as native JSON array produces iPAddress SANs", () => {
    const ctx = makeIssuerContext({ require_factory_cert: false });
    const msg = makeOpenRequest("san-ip-native-1", {
      san_ip_addresses: ["192.168.1.42"],
    });
    const cert = parseCertFromOutput(flow.onMessage(msg, ctx));
    expect(getSAN(cert)).toMatch(/IP Address:192\.168\.1\.42/i);
  });

  test("invalid san_dns_names JSON is rejected", () => {
    const ctx = makeIssuerContext({ require_factory_cert: false });
    const msg = makeOpenRequest("san-invalid-dns-1", {
      san_dns_names: "not-valid-json",
    });
    const output = flow.onMessage(msg, ctx);
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  test("invalid san_ip_addresses JSON is rejected", () => {
    const ctx = makeIssuerContext({ require_factory_cert: false });
    const msg = makeOpenRequest("san-invalid-ip-1", {
      san_ip_addresses: "{bad}",
    });
    const output = flow.onMessage(msg, ctx);
    expect(output[0].topic).toBe(`te/pki/x509/req/rejected/${DEVICE_ID}`);
  });

  // ── SAN retention during renewal ─────────────────────────────────────────

  test("renewal without SAN fields inherits SANs from the current certificate", () => {
    const ctx = makeIssuerContext({ require_factory_cert: false });

    // Issue initial cert with SANs
    const initMsg = makeOpenRequest("san-renew-inherit-init", {
      san_dns_names: JSON.stringify(["device.local"]),
      san_ip_addresses: JSON.stringify(["10.1.2.3"]),
    });
    const initCertDerB64 = JSON.parse(
      flow.onMessage(initMsg, ctx)[0].payload as string,
    ).cert_der as string;

    // Renew without providing SAN fields
    const sig = makeRenewalReqSig(
      DEVICE_ID,
      "san-renew-inherit-1",
      OP_PUB,
      OP_PRIV,
    );
    const renewMsg = makeRenewalRequest({
      nonce: "san-renew-inherit-1",
      current_cert_der_b64: initCertDerB64,
      req_sig: sig,
    });
    const renewedCert = parseCertFromOutput(flow.onMessage(renewMsg, ctx));
    const san = getSAN(renewedCert);
    expect(san).toMatch(/DNS:device\.local/);
    expect(san).toMatch(/IP Address:10\.1\.2\.3/i);
  });

  test("renewal with new san_dns_names overrides the original SANs", () => {
    const ctx = makeIssuerContext({ require_factory_cert: false });

    // Issue initial cert with one SAN
    const initMsg = makeOpenRequest("san-renew-override-init", {
      san_dns_names: JSON.stringify(["old.local"]),
    });
    const initCertDerB64 = JSON.parse(
      flow.onMessage(initMsg, ctx)[0].payload as string,
    ).cert_der as string;

    // Renew providing different SANs
    const sig = makeRenewalReqSig(
      DEVICE_ID,
      "san-renew-override-1",
      OP_PUB,
      OP_PRIV,
    );
    const renewMsg: tedge.Message = {
      time: new Date(),
      topic: "te/pki/x509/renew",
      payload: JSON.stringify({
        device_id: DEVICE_ID,
        public_key: OP_PUB,
        nonce: "san-renew-override-1",
        _current_cert: initCertDerB64,
        _req_sig: sig,
        san_dns_names: JSON.stringify(["new.local"]),
      }),
    };
    const renewedCert = parseCertFromOutput(flow.onMessage(renewMsg, ctx));
    const san = getSAN(renewedCert);
    expect(san).toMatch(/DNS:new\.local/);
    expect(san).not.toMatch(/DNS:old\.local/);
  });

  test("renewal of a cert without SANs (and no new SANs provided) produces a cert with no SAN extension", () => {
    const ctx = makeIssuerContext({ require_factory_cert: false });

    // Issue initial cert without SANs
    const initMsg = makeOpenRequest("san-renew-none-init");
    const initCertDerB64 = JSON.parse(
      flow.onMessage(initMsg, ctx)[0].payload as string,
    ).cert_der as string;

    // Renew without providing SANs
    const sig = makeRenewalReqSig(
      DEVICE_ID,
      "san-renew-none-1",
      OP_PUB,
      OP_PRIV,
    );
    const renewedCert = parseCertFromOutput(
      flow.onMessage(
        makeRenewalRequest({
          nonce: "san-renew-none-1",
          current_cert_der_b64: initCertDerB64,
          req_sig: sig,
        }),
        ctx,
      ),
    );
    expect(getSAN(renewedCert)).toBe("");
  });
});
