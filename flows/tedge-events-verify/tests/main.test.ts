import { expect, test, describe, beforeAll } from "@jest/globals";
import * as crypto from "crypto";
import * as tedge from "../../common/tedge";
import { uint8ToBase64 } from "../../common/tedge";
import * as flow from "../src/main";
import * as signer from "../../tedge-events-signed/src/main";
import * as x509Flow from "../../x509-cert-issuer/src/main";
import { ed25519 } from "@noble/curves/ed25519.js";

// All keypairs generated fresh each test run — never committed
const TEST_PRIVATE_KEY_BYTES = ed25519.utils.randomSecretKey();
const TEST_PRIVATE_KEY = bytesToHex(TEST_PRIVATE_KEY_BYTES);
const TEST_PUBLIC_KEY = bytesToHex(ed25519.getPublicKey(TEST_PRIVATE_KEY_BYTES));
const DEVICE_SOURCE = "my-device";

const CA_PRIVATE_KEY_BYTES = ed25519.utils.randomSecretKey();
const CA_PRIVATE_KEY = bytesToHex(CA_PRIVATE_KEY_BYTES);
const CA_PUBLIC_KEY = bytesToHex(ed25519.getPublicKey(CA_PRIVATE_KEY_BYTES));

const DEVICE2_PRIVATE_KEY_BYTES = ed25519.utils.randomSecretKey();
const DEVICE2_PRIVATE_KEY = bytesToHex(DEVICE2_PRIVATE_KEY_BYTES);
const DEVICE2_PUBLIC_KEY = bytesToHex(ed25519.getPublicKey(DEVICE2_PRIVATE_KEY_BYTES));

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

function makeCertificate(
  deviceId: string,
  devicePublicKeyHex: string,
  caPrivateKeyHex: string,
  expires?: string,
): string {
  const certBody: Record<string, string> = {
    device_id: deviceId,
    public_key: devicePublicKeyHex,
  };
  if (expires) certBody.expires = expires;
  const encoder = new TextEncoder();
  const canonical = JSON.stringify(certBody, Object.keys(certBody).sort());
  const sig = ed25519.sign(encoder.encode(canonical), hexToBytes(caPrivateKeyHex));
  const cert = { ...certBody, _cert_sig: uint8ToBase64(sig) };
  return uint8ToBase64(encoder.encode(JSON.stringify(cert)));
}

function makeSignedMessage(
  text: string = "door opened",
  source: string = DEVICE_SOURCE,
  privateKey: string = TEST_PRIVATE_KEY,
  deviceCert?: string,
): tedge.Message {
  const config: Record<string, unknown> = { private_key: privateKey };
  if (deviceCert !== undefined) config.device_cert = deviceCert;
  const signerContext = tedge.createContext(config);
  signerContext.mapper.set("device.id", source);
  const out = signer.onMessage(
    {
      time: new Date("2026-01-01"),
      topic: "te/device/main///e/myEvent",
      payload: JSON.stringify({ text }),
    },
    signerContext,
  );
  return out[0] as tedge.Message;
}

function makeVerifierContext(
  publicKeys: Record<string, string> = { [DEVICE_SOURCE]: TEST_PUBLIC_KEY },
  extra: Record<string, unknown> = {},
) {
  return tedge.createContext({
    public_keys: JSON.stringify(publicKeys),
    ...extra,
  });
}

// X.509 CA — set up in beforeAll using Node crypto + openssl (same pattern as x509-cert-issuer tests)
let X509_CA_PRIV_HEX: string;
let X509_CA_PUB_HEX: string;
let X509_CA_CERT_DER_B64: string;

beforeAll(() => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const privDer = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  X509_CA_PRIV_HEX = privDer.slice(-32).toString("hex");
  X509_CA_PUB_HEX = bytesToHex(ed25519.getPublicKey(hexToBytes(X509_CA_PRIV_HEX)));

  const { execSync } = require("child_process");
  execSync(
    `openssl req -new -x509 -key /dev/stdin -out /tmp/ca-verify-jest.pem -days 3650 -subj "/CN=TestCAVerify" 2>/dev/null`,
    { input: privateKey.export({ type: "pkcs8", format: "pem" }) as string },
  );
  const derBuf = execSync(`openssl x509 -in /tmp/ca-verify-jest.pem -outform DER 2>/dev/null`) as Buffer;
  X509_CA_CERT_DER_B64 = derBuf.toString("base64");
});

describe("verified messages", () => {
  test("valid signature is forwarded to output_verified_topic", () => {
    const signed = makeSignedMessage();
    const context = makeVerifierContext();

    const output = flow.onMessage(signed, context);

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/verified/events");
    expect(tedge.decodeJsonPayload(output[0].payload)).toMatchObject({
      source: DEVICE_SOURCE,
      payloadType: "event",
    });
  });

  test("custom output_verified_topic is used", () => {
    const signed = makeSignedMessage();
    const context = makeVerifierContext(
      { [DEVICE_SOURCE]: TEST_PUBLIC_KEY },
      { output_verified_topic: "custom/verified" },
    );

    const output = flow.onMessage(signed, context);

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("custom/verified");
  });

  test("valid message produces no output when output_verified_topic is empty", () => {
    const signed = makeSignedMessage();
    const context = makeVerifierContext(
      { [DEVICE_SOURCE]: TEST_PUBLIC_KEY },
      { output_verified_topic: "" },
    );

    const output = flow.onMessage(signed, context);

    expect(output).toHaveLength(0);
  });
});

describe("rejected messages", () => {
  test("tampered payload is forwarded to output_rejected_topic", () => {
    const signed = makeSignedMessage();
    // tamper with the payload
    const payload = tedge.decodeJsonPayload(signed.payload);
    payload.text = "tampered text";
    const tampered = { ...signed, payload: JSON.stringify(payload) };

    const context = makeVerifierContext();
    const output = flow.onMessage(tampered, context);

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/rejected/events");
  });

  test("message with no _sig is rejected", () => {
    const unsigned = {
      time: new Date("2026-01-01"),
      topic: "c8y/mqtt/out/te/v1/events",
      payload: JSON.stringify({
        text: "no sig",
        source: DEVICE_SOURCE,
        payloadType: "event",
      }),
    };

    const output = flow.onMessage(unsigned, makeVerifierContext());

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/rejected/events");
  });

  test("message from unknown device is rejected", () => {
    const signed = makeSignedMessage("door opened", "unknown-device");
    const output = flow.onMessage(signed, makeVerifierContext());

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/rejected/events");
  });

  test("message signed with wrong key is rejected", () => {
    const signed = makeSignedMessage("door opened", DEVICE_SOURCE, CA_PRIVATE_KEY);
    const output = flow.onMessage(signed, makeVerifierContext());

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/rejected/events");
  });

  test("rejected message produces no output when output_rejected_topic is empty", () => {
    const unsigned = {
      time: new Date("2026-01-01"),
      topic: "c8y/mqtt/out/te/v1/events",
      payload: JSON.stringify({ text: "no sig", source: DEVICE_SOURCE }),
    };

    const context = makeVerifierContext(
      { [DEVICE_SOURCE]: TEST_PUBLIC_KEY },
      { output_rejected_topic: "" },
    );
    const output = flow.onMessage(unsigned, context);

    expect(output).toHaveLength(0);
  });
});

describe("multiple devices", () => {
  test("correctly routes messages from different devices", () => {
    const context = makeVerifierContext({
      [DEVICE_SOURCE]: TEST_PUBLIC_KEY,
      "device-2": DEVICE2_PUBLIC_KEY,
    });

    const msg1 = makeSignedMessage("event from device 1", DEVICE_SOURCE, TEST_PRIVATE_KEY);
    const msg2 = makeSignedMessage("event from device 2", "device-2", DEVICE2_PRIVATE_KEY);

    const out1 = flow.onMessage(msg1, context);
    const out2 = flow.onMessage(msg2, context);

    expect(out1[0].topic).toBe("te/verified/events");
    expect(out2[0].topic).toBe("te/verified/events");
  });
});

describe("PKI certificate mode", () => {
  const DEVICE_CERT = makeCertificate(DEVICE_SOURCE, TEST_PUBLIC_KEY, CA_PRIVATE_KEY);

  function makeVerifierContextPKI(extra: Record<string, unknown> = {}) {
    return tedge.createContext({ root_ca_public_key: CA_PUBLIC_KEY, ...extra });
  }

  test("valid cert and valid signature → verified", () => {
    const signed = makeSignedMessage("door opened", DEVICE_SOURCE, TEST_PRIVATE_KEY, DEVICE_CERT);
    const output = flow.onMessage(signed, makeVerifierContextPKI());
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/verified/events");
  });

  test("message without _cert in PKI mode → rejected", () => {
    const signed = makeSignedMessage(); // no device_cert attached
    const output = flow.onMessage(signed, makeVerifierContextPKI());
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/rejected/events");
  });

  test("tampered payload → rejected", () => {
    const signed = makeSignedMessage("door opened", DEVICE_SOURCE, TEST_PRIVATE_KEY, DEVICE_CERT);
    const payload = tedge.decodeJsonPayload(signed.payload);
    payload.text = "tampered text";
    const tampered = { ...signed, payload: JSON.stringify(payload) };
    const output = flow.onMessage(tampered, makeVerifierContextPKI());
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/rejected/events");
  });

  test("cert signed by wrong CA → rejected", () => {
    const wrongCACert = makeCertificate(DEVICE_SOURCE, TEST_PUBLIC_KEY, TEST_PRIVATE_KEY);
    const signed = makeSignedMessage("event", DEVICE_SOURCE, TEST_PRIVATE_KEY, wrongCACert);
    const output = flow.onMessage(signed, makeVerifierContextPKI());
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/rejected/events");
  });

  test("expired certificate → rejected", () => {
    const expiredCert = makeCertificate(DEVICE_SOURCE, TEST_PUBLIC_KEY, CA_PRIVATE_KEY, "2020-01-01T00:00:00Z");
    const signed = makeSignedMessage("event", DEVICE_SOURCE, TEST_PRIVATE_KEY, expiredCert);
    const output = flow.onMessage(signed, makeVerifierContextPKI());
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/rejected/events");
  });

  test("future expiry is accepted", () => {
    const futureCert = makeCertificate(DEVICE_SOURCE, TEST_PUBLIC_KEY, CA_PRIVATE_KEY, "2099-01-01T00:00:00Z");
    const signed = makeSignedMessage("event", DEVICE_SOURCE, TEST_PRIVATE_KEY, futureCert);
    const output = flow.onMessage(signed, makeVerifierContextPKI());
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/verified/events");
  });

  test("multiple devices with separate certs from same CA", () => {
    const cert2 = makeCertificate("device-2", DEVICE2_PUBLIC_KEY, CA_PRIVATE_KEY);

    const msg1 = makeSignedMessage("event 1", DEVICE_SOURCE, TEST_PRIVATE_KEY, DEVICE_CERT);
    const msg2 = makeSignedMessage("event 2", "device-2", DEVICE2_PRIVATE_KEY, cert2);

    const context = makeVerifierContextPKI();
    expect(flow.onMessage(msg1, context)[0].topic).toBe("te/verified/events");
    expect(flow.onMessage(msg2, context)[0].topic).toBe("te/verified/events");
  });
});

describe("PKI X.509 certificate mode (x509-cert-issuer)", () => {
  function makeX509IssuerContext(extra: Record<string, unknown> = {}) {
    return tedge.createContext({
      ca_private_key: X509_CA_PRIV_HEX,
      ca_cert_der: X509_CA_CERT_DER_B64,
      require_factory_cert: false,
      ...extra,
    });
  }

  function issueX509DeviceCert(devicePubHex: string, nonce: string): string {
    const ctx = makeX509IssuerContext();
    const output = x509Flow.onMessage(
      {
        time: new Date(),
        topic: "te/pki/x509/csr",
        payload: JSON.stringify({ device_id: DEVICE_SOURCE, public_key: devicePubHex, nonce }),
      },
      ctx,
    );
    expect(output).toHaveLength(1);
    return JSON.parse(output[0].payload as string).cert_der;
  }

  function makeVerifierContextX509(extra: Record<string, unknown> = {}) {
    return tedge.createContext({ root_ca_public_key: X509_CA_PUB_HEX, ...extra });
  }

  test("valid X.509 cert + valid signature → verified", () => {
    const certDer = issueX509DeviceCert(TEST_PUBLIC_KEY, "nonce-x509-valid-1");
    const signed = makeSignedMessage("door opened", DEVICE_SOURCE, TEST_PRIVATE_KEY, certDer);
    const output = flow.onMessage(signed, makeVerifierContextX509());
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/verified/events");
  });

  test("tampered payload → rejected", () => {
    const certDer = issueX509DeviceCert(TEST_PUBLIC_KEY, "nonce-x509-tamper-1");
    const signed = makeSignedMessage("door opened", DEVICE_SOURCE, TEST_PRIVATE_KEY, certDer);
    const payload = tedge.decodeJsonPayload(signed.payload);
    payload.text = "tampered";
    const tampered = { ...signed, payload: JSON.stringify(payload) };
    const output = flow.onMessage(tampered, makeVerifierContextX509());
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/rejected/events");
  });

  test("cert signed by wrong CA → rejected", () => {
    const certDer = issueX509DeviceCert(TEST_PUBLIC_KEY, "nonce-x509-wrongca-1");
    const signed = makeSignedMessage("door opened", DEVICE_SOURCE, TEST_PRIVATE_KEY, certDer);
    // Verify with a different (JSON PKI) CA public key — will fail cert sig check
    const wrongContext = tedge.createContext({ root_ca_public_key: CA_PUBLIC_KEY });
    const output = flow.onMessage(signed, wrongContext);
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/rejected/events");
  });

  test("signed with wrong device key → rejected", () => {
    const certDer = issueX509DeviceCert(TEST_PUBLIC_KEY, "nonce-x509-wrongkey-1");
    // Sign with a different private key than the one in the cert
    const signed = makeSignedMessage("door opened", DEVICE_SOURCE, CA_PRIVATE_KEY, certDer);
    const output = flow.onMessage(signed, makeVerifierContextX509());
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/rejected/events");
  });

  test("missing _cert in PKI mode → rejected", () => {
    // Sign without attaching a cert
    const signed = makeSignedMessage("door opened", DEVICE_SOURCE, TEST_PRIVATE_KEY);
    const output = flow.onMessage(signed, makeVerifierContextX509());
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/rejected/events");
  });

  test("multiple devices with separate X.509 certs from same CA", () => {
    const cert1 = issueX509DeviceCert(TEST_PUBLIC_KEY, "nonce-x509-multi-1");
    // For device 2 we need to issue a cert with device-2's public key
    const ctx2 = makeX509IssuerContext();
    const out2 = x509Flow.onMessage(
      {
        time: new Date(),
        topic: "te/pki/x509/csr",
        payload: JSON.stringify({ device_id: "device-2", public_key: DEVICE2_PUBLIC_KEY, nonce: "nonce-x509-multi-2" }),
      },
      ctx2,
    );
    const cert2 = JSON.parse(out2[0].payload as string).cert_der;

    const msg1 = makeSignedMessage("event 1", DEVICE_SOURCE, TEST_PRIVATE_KEY, cert1);
    const msg2 = makeSignedMessage("event 2", "device-2", DEVICE2_PRIVATE_KEY, cert2);

    const context = makeVerifierContextX509();
    expect(flow.onMessage(msg1, context)[0].topic).toBe("te/verified/events");
    expect(flow.onMessage(msg2, context)[0].topic).toBe("te/verified/events");
  });
});

