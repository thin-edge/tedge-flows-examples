import {
  Message,
  Context,
  decodePayload,
  decodeJsonPayload,
} from "../../common/tedge";

function isEmptyPayload(payload: Message["payload"]): boolean {
  return decodePayload(payload).trim() === "";
}

export interface Config {
  topic_root?: string;
}

export interface FlowContext extends Context {
  config: Config;
}

export function onMessage(message: Message, context: FlowContext): Message[] {
  const { topic_root = "te" } = context.config || {};
  const parts = message.topic.split("/");
  const msgType = parts[1]; // measurements | events | alarms

  if (msgType === "measurements") {
    // tedge/measurements                → te/device/main///m/
    // tedge/measurements/<child_id>     → te/device/<child_id>///m/
    const device = parts[2] ?? "main";
    return [
      {
        time: message.time,
        topic: `${topic_root}/device/${device}///m/`,
        payload: message.payload,
      },
    ];
  }

  if (msgType === "events") {
    if (parts.length === 3) {
      // tedge/events/<type>             → te/device/main///e/<type>
      return [
        {
          time: message.time,
          topic: `${topic_root}/device/main///e/${parts[2]}`,
          payload: message.payload,
        },
      ];
    }
    // tedge/events/<type>/<child_id>    → te/device/<child_id>///e/<type>
    return [
      {
        time: message.time,
        topic: `${topic_root}/device/${parts[3]}///e/${parts[2]}`,
        payload: message.payload,
      },
    ];
  }

  if (msgType === "alarms") {
    const severity = parts[2];
    const type = parts[3];
    const device = parts.length === 4 ? "main" : parts[4];
    const newTopic = `${topic_root}/device/${device}///a/${type}`;

    // An empty retained message clears the alarm — pass it through as-is.
    if (isEmptyPayload(message.payload)) {
      return [
        {
          time: message.time,
          topic: newTopic,
          payload: message.payload,
          mqtt: { retain: true, qos: 1 },
        },
      ];
    }

    const payload = decodeJsonPayload(message.payload);
    return [
      {
        time: message.time,
        topic: newTopic,
        payload: JSON.stringify({ ...payload, severity }),
        mqtt: { retain: true, qos: 1 },
      },
    ];
  }
  return [];
}
