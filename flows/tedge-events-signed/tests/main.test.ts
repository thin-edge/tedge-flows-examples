import { expect, test, describe } from "@jest/globals";
import * as tedge from "../../common/tedge";
import { uint8ToBase64 } from "../../common/tedge";
import * as flow from "../src/main";
import { ed25519 } from "@noble/curves/ed25519.js";

// Test keypair — generated fresh each test run, never committed
const TEST_PRIVATE_KEY_BYTES = ed25519.utils.randomSecretKey();
const TEST_PRIVATE_KEY = bytesToHex(TEST_PRIVATE_KEY_BYTES);
const TEST_PUBLIC_KEY = ed25519.getPublicKey(TEST_PRIVATE_KEY_BYTES);

// CA keypair for PKI tests — generated fresh each test run, never committed
const CA_PRIVATE_KEY_BYTES = ed25519.utils.randomSecretKey();
const CA_PRIVATE_KEY = bytesToHex(CA_PRIVATE_KEY_BYTES);

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

describe("map messages", () => {
  test.each([
    {
      description: "event with text field",
      topic: "te/device/main///e/myEvent",
      inputPayload: { text: "door opened", temperature: 22.5 },
      config: {},
      contextMapper: {},
      expectedTopic: "c8y/mqtt/out/te/v1/events",
      expectedPayload: {
        temperature: 22.5,
        text: "door opened (from mqtt-service)",
        tedgeSequence: 1,
        type: "myEvent",
        payloadType: "event",
        source: "main",
      },
    },
    {
      description: "event without text uses default",
      topic: "te/device/main///e/restart",
      inputPayload: { reason: "ota" },
      config: {},
      contextMapper: {},
      expectedTopic: "c8y/mqtt/out/te/v1/events",
      expectedPayload: {
        reason: "ota",
        text: "test event (from mqtt-service)",
        tedgeSequence: 1,
        type: "restart",
        payloadType: "event",
        source: "main",
      },
    },
    {
      description: "device.id from mapper context is used as source",
      topic: "te/device/main///e/myEvent",
      inputPayload: { text: "motion detected" },
      config: {},
      contextMapper: { "device.id": "my-device" },
      expectedTopic: "c8y/mqtt/out/te/v1/events",
      expectedPayload: {
        text: "motion detected (from mqtt-service)",
        tedgeSequence: 1,
        type: "myEvent",
        payloadType: "event",
        source: "my-device",
      },
    },
    {
      description: "custom output_events_topic from config",
      topic: "te/device/main///e/alarm",
      inputPayload: { text: "high temp" },
      config: { output_events_topic: "custom/events/out" },
      contextMapper: {},
      expectedTopic: "custom/events/out",
      expectedPayload: {
        text: "high temp (from mqtt-service)",
        tedgeSequence: 1,
        type: "alarm",
        payloadType: "event",
        source: "main",
      },
    },
  ])(
    "$description",
    ({
      topic,
      inputPayload,
      config,
      contextMapper,
      expectedTopic,
      expectedPayload,
    }) => {
      const context = tedge.createContext(config);
      for (const [k, v] of Object.entries(contextMapper)) {
        context.mapper.set(k, v);
      }

      const output = flow.onMessage(
        {
          time: new Date("2026-01-01"),
          topic,
          payload: JSON.stringify(inputPayload),
        },
        context,
      );

      expect(output).toHaveLength(1);
      expect(output[0].topic).toBe(expectedTopic);
      const payload = tedge.decodeJsonPayload(output[0].payload);
      expect(payload).toMatchObject(expectedPayload);
    },
  );

  test("sequence counter increments with each message", () => {
    const context = tedge.createContext({});
    const msg = {
      time: new Date("2026-01-01"),
      topic: "te/device/main///e/myEvent",
      payload: JSON.stringify({ text: "ping" }),
    };

    const first = tedge.decodeJsonPayload(
      flow.onMessage(msg, context)[0].payload,
    );
    const second = tedge.decodeJsonPayload(
      flow.onMessage(msg, context)[0].payload,
    );
    const third = tedge.decodeJsonPayload(
      flow.onMessage(msg, context)[0].payload,
    );

    expect(first.tedgeSequence).toBe(1);
    expect(second.tedgeSequence).toBe(2);
    expect(third.tedgeSequence).toBe(3);
  });
});

describe("Ed25519 signing", () => {
  test("no _sig field when private_key is not configured", () => {
    const context = tedge.createContext({});
    const output = flow.onMessage(
      {
        time: new Date("2026-01-01"),
        topic: "te/device/main///e/myEvent",
        payload: JSON.stringify({ text: "door opened" }),
      },
      context,
    );

    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload._sig).toBeUndefined();
  });

  test("_sig field is present when private_key is configured", () => {
    const context = tedge.createContext({ private_key: TEST_PRIVATE_KEY });
    const output = flow.onMessage(
      {
        time: new Date("2026-01-01"),
        topic: "te/device/main///e/myEvent",
        payload: JSON.stringify({ text: "door opened" }),
      },
      context,
    );

    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(typeof payload._sig).toBe("string");
    expect(payload._sig.length).toBeGreaterThan(0);
  });

  test("_sig is a valid Ed25519 signature verifiable with the public key", () => {
    const context = tedge.createContext({ private_key: TEST_PRIVATE_KEY });
    const output = flow.onMessage(
      {
        time: new Date("2026-01-01"),
        topic: "te/device/main///e/myEvent",
        payload: JSON.stringify({ text: "door opened" }),
      },
      context,
    );

    const { _sig, ...payloadWithoutSig } = tedge.decodeJsonPayload(
      output[0].payload,
    );

    const encoder = new TextEncoder();
    const canonical = JSON.stringify(payloadWithoutSig, Object.keys(payloadWithoutSig).sort());
    const sigBytes = hexToBytes(
      Buffer.from(_sig, "base64").toString("hex"),
    );
    expect(ed25519.verify(sigBytes, encoder.encode(canonical), TEST_PUBLIC_KEY)).toBe(true);
  });

  test("signature is invalid if payload is tampered with", () => {
    const context = tedge.createContext({ private_key: TEST_PRIVATE_KEY });
    const output = flow.onMessage(
      {
        time: new Date("2026-01-01"),
        topic: "te/device/main///e/myEvent",
        payload: JSON.stringify({ text: "door opened" }),
      },
      context,
    );

    const { _sig, ...payloadWithoutSig } = tedge.decodeJsonPayload(
      output[0].payload,
    );
    // tamper with the payload
    payloadWithoutSig.text = "tampered";

    const encoder2 = new TextEncoder();
    const canonical2 = JSON.stringify(payloadWithoutSig, Object.keys(payloadWithoutSig).sort());
    const sigBytes2 = hexToBytes(
      Buffer.from(_sig, "base64").toString("hex"),
    );
    expect(ed25519.verify(sigBytes2, encoder2.encode(canonical2), TEST_PUBLIC_KEY)).toBe(false);
  });

  test("different private keys produce different signatures", () => {
    const msg = {
      time: new Date("2026-01-01"),
      topic: "te/device/main///e/myEvent",
      payload: JSON.stringify({ text: "door opened" }),
    };

    const out1 = flow.onMessage(msg, tedge.createContext({ private_key: TEST_PRIVATE_KEY }));
    const out2 = flow.onMessage(msg, tedge.createContext({ private_key: CA_PRIVATE_KEY }));

    const { _sig: sig1 } = tedge.decodeJsonPayload(out1[0].payload);
    const { _sig: sig2 } = tedge.decodeJsonPayload(out2[0].payload);

    expect(sig1).not.toBe(sig2);
  });
});

describe("PKI certificate", () => {
  const DEVICE_SOURCE = "my-device";
  const baseMsg = {
    time: new Date("2026-01-01"),
    topic: "te/device/main///e/myEvent",
    payload: JSON.stringify({ text: "door opened" }),
  };

  function makeContext(config: Record<string, unknown> = {}) {
    const ctx = tedge.createContext(config);
    ctx.mapper.set("device.id", DEVICE_SOURCE);
    return ctx;
  }

  test("_cert is attached when device_cert is configured", () => {
    const cert = makeCertificate(DEVICE_SOURCE, bytesToHex(TEST_PUBLIC_KEY), CA_PRIVATE_KEY);
    const context = makeContext({ private_key: TEST_PRIVATE_KEY, device_cert: cert });
    const output = flow.onMessage(baseMsg, context);
    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload._cert).toBe(cert);
    expect(typeof payload._sig).toBe("string");
  });

  test("_cert is not attached when device_cert is not configured", () => {
    const context = makeContext({ private_key: TEST_PRIVATE_KEY });
    const output = flow.onMessage(baseMsg, context);
    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload._cert).toBeUndefined();
  });

  test("_cert is not included in the signed canonical form", () => {
    const cert = makeCertificate(DEVICE_SOURCE, bytesToHex(TEST_PUBLIC_KEY), CA_PRIVATE_KEY);
    const context = makeContext({ private_key: TEST_PRIVATE_KEY, device_cert: cert });
    const output = flow.onMessage(baseMsg, context);
    const { _sig, _cert, ...rest } = tedge.decodeJsonPayload(output[0].payload);
    const encoder = new TextEncoder();
    const canonical = JSON.stringify(rest, Object.keys(rest).sort());
    const sigBytes = Buffer.from(_sig, "base64");
    expect(ed25519.verify(sigBytes, encoder.encode(canonical), TEST_PUBLIC_KEY)).toBe(true);
  });

  test("_cert is not attached when no private_key configured", () => {
    const cert = makeCertificate(DEVICE_SOURCE, bytesToHex(TEST_PUBLIC_KEY), CA_PRIVATE_KEY);
    const context = makeContext({ device_cert: cert });
    const output = flow.onMessage(baseMsg, context);
    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload._cert).toBeUndefined();
    expect(payload._sig).toBeUndefined();
  });
});
