import { Message, Context, decodeJsonPayload, uint8ToBase64 } from "../../common/tedge";
import { ed25519 } from "@noble/curves/ed25519.js";

export interface Config {
  debug?: boolean;
  output_events_topic?: string;
  /** Hex-encoded 32-byte Ed25519 private key. */
  private_key?: string;
  /**
   * Base64-encoded device certificate JSON issued by the root CA.
   * When set, the certificate is attached to outgoing messages as `_cert`.
   * Use with the verifier flow's `root_ca_public_key` config for PKI mode.
   */
  device_cert?: string;
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

function signPayload(payload: object, privKeyHex: string): string {
  const encoder = new TextEncoder();
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const sig = ed25519.sign(encoder.encode(canonical), hexToBytes(privKeyHex));
  return uint8ToBase64(sig);
}

export function onMessage(message: Message, context: FlowContext) {
  const messageType = message.topic.split("/").slice(-1)[0];

  // read device.id from the mapper context (if available)
  const source = context.mapper.get("device.id") || "main";

  const {
    output_events_topic = "c8y/mqtt/out/te/v1/events",
    debug = false,
    private_key,
    device_cert,
  } = context.config;

  // use a sequence counter
  const seq = context.script.get("seq") || 1;
  context.script.set("seq", seq + 1);

  const payload = decodeJsonPayload(message.payload);

  if (debug) {
    console.log(`Processing message`, { payload });
  }

  // remove the text from the payload
  const { text, ...properties } = payload;
  const outputPayload: Record<string, unknown> = {
    ...properties,
    text: `${text || "test event"} (from mqtt-service)`,
    tedgeSequence: seq,
    type: messageType,
    payloadType: "event",
    source,
  };

  if (private_key) {
    outputPayload._sig = signPayload(outputPayload, private_key);
    if (device_cert) {
      outputPayload._cert = device_cert;
    }
  }

  return [
    {
      topic: output_events_topic,
      payload: JSON.stringify(outputPayload),
    },
  ];
}
