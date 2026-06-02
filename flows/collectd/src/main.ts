import { Message, Context, decodePayload } from "../../common/tedge";

export interface Config {
  topic?: string;
}

export interface FlowContext extends Context {
  config: Config;
}

export function onMessage(message: Message, context: FlowContext): Message[] {
  const output = [];
  const { topic = "te/device/main///m/collectd" } = context.config;

  const groups = message.topic.split("/");
  const data = decodePayload(message.payload).split(":");

  if (groups.length < 4) {
    throw new Error("Not a collectd topic");
  }
  if (data.length < 2) {
    throw new Error("Not a collectd payload");
  }

  let group = groups[2];
  let measurement = groups[3];
  let time = data[0];
  let values = data.slice(1);

  values.forEach((value, index) => {
    let key = measurement;
    if (values.length > 1) {
      key = `${measurement}_val${index}`;
    }
    output.push({
      time: time * 1000,
      topic,
      payload: `{"time": ${time}, "${group}": {"${key}": ${value}}}`,
    });
  });

  return output;
}
