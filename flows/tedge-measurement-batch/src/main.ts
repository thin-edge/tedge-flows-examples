import { Message, Context, decodeJsonPayload } from "../../common/tedge";

export interface Config {
  debug?: boolean;
}

export interface FlowContext extends Context {
  config: Config;
}

/**
 * Split a batched ThinEdge JSON measurement payload (an array of measurement
 * objects) into individual messages, one per array element.  If an element
 * does not include a "time" field the message's receive time is used as a
 * fallback so that every outgoing message is always timestamped.
 *
 * Non-array payloads are ignored (empty output) so the built-in thin-edge.io
 * flow handles them without interference.
 */
export function onMessage(message: Message, context: FlowContext): Message[] {
  const { debug = false } = context.config;

  const payload = decodeJsonPayload(message.payload);

  if (debug) {
    console.log("Received message", { topic: message.topic, payload });
  }

  // Non-array payloads are not batched – drop them so the built-in
  // thin-edge.io flow handles them without interference.
  if (!Array.isArray(payload)) {
    return [];
  }

  const fallbackTime = message.time.toISOString();

  return payload.map((item) => ({
    time: item.time ? new Date(item.time) : message.time,
    topic: message.topic,
    payload: JSON.stringify({
      time: fallbackTime,
      ...item,
    }),
  }));
}
