import {
  Message,
  Context,
  encodeText,
  encodeJSON,
  decodeJSON,
} from "../../common/tedge";
import * as utils from "./utils";

export interface Config {
  cloud_prefix?: string;
  commands?: string[];
}

function isTedgeCommandStatus(cloudPrefix: string, topic: string): boolean {
  const pattern = RegExp(`/cmd/[^/]+/${cloudPrefix}-[0-9]+$`);
  return !!topic.match(pattern);
}

function handleCommandUpdate(message: Message): Message[] {
  const output: Message[] = [];
  if (message.payload.length === 0) {
    return output;
  }

  const payload = decodeJSON(message.payload);

  if (payload?.status == "successful" || payload?.status == "failed") {
    // clear message
    output.push({
      topic: message.topic,
      transportFields: {
        retain: true,
      },
      payload: encodeText(""),
    });
  } else {
    // TODO: send current status to the cloud
  }
  return output;
}

function createCommand(
  message: Message,
  cloudPayload: any,
  config?: Config,
): Message[] {
  const messages: Message[] = [];
  const tedgeTopic = utils.getTedgeTopicID(message.topic);
  if (!tedgeTopic) {
    console.error("tedge topic is ill-formed", {
      cloudTopic: message.topic,
      localTopic: tedgeTopic,
    });
    return messages;
  }
  const { cloud_prefix = "azeg" } = config || {};

  // map cloud payloads to local payload if required
  const payload = {
    ...cloudPayload,
    status: "init",
    ["_" + cloud_prefix]: {
      prefix: cloud_prefix,
    },
  };

  messages.push({
    time: message.time,
    topic: [
      tedgeTopic,
      "cmd",
      cloudPayload.type,
      buildCommandID(cloud_prefix, message),
    ].join("/"),
    payload: encodeJSON(payload),
  });
  return messages;
}

function buildCommandID(cloudPrefix: string, message: Message): string {
  return [cloudPrefix, message.time?.getTime()].join("-");
}

export function onMessage(message: Message, context: Context): Message[] {
  const { cloud_prefix = "azeg", commands = ["writeSetpoint"] } =
    context.config;
  if (isTedgeCommandStatus(cloud_prefix, message.topic)) {
    return handleCommandUpdate(message);
  }

  // map a cloud message to a local tedge command based on the .type
  const output: Message[] = [];
  const payload = decodeJSON(message.payload);
  if (commands.includes(payload.type)) {
    output.push(...createCommand(message, payload, context.config));
  }
  return output;
}
