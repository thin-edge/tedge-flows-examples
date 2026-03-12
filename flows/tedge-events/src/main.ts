import { Message, Context, decodeJsonPayload } from "../../common/tedge";

export interface Config {
  debug?: boolean;
  output_events_topic?: string;
}

export interface FlowContext extends Context {
  config: Config;
}

export function onMessage(message: Message, context: FlowContext) {
  const messageType = message.topic.split("/").slice(-1)[0];

  // read device.id from the mapper context (if available)
  const source = context.mapper.get("device.id") ?? "";

  const { output_events_topic = "c8y/mqtt/out/te/v1/events", debug = false } =
    context.config;

  // use a sequence counter
  const seq = context.script.get("seq") || 1;
  context.script.set("seq", seq + 1);

  const payload = decodeJsonPayload(message.payload);

  if (debug) {
    console.log(`Processing message`, { payload });
  }

  // remove the text from the payload
  const { text, ...properties } = payload;
  return [
    {
      topic: output_events_topic,
      payload: JSON.stringify({
        ...properties,
        text: `${text || "test event"} (from mqtt-service)`,
        tedgeSequence: seq,
        type: messageType,
        payloadType: "event",
        source,
      }),
    },
  ];
}
