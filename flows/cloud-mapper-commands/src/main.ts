import { Message } from "../../common/tedge";
import * as utils from "./utils";

export interface Config {
  cloud_prefix?: string;
  commands?: string[];
}

function isTedgeCommandStatus(cloudPrefix: string, topic: string): boolean {
  const pattern = RegExp(`/cmd/[^/]+/${cloudPrefix}-[0-9]+$`);
  return !!topic.match(pattern);
}

function handleCommandUpdate(message: Message): any[] {
  const output: any[] = [];
  if (!message.payload) {
    return output;
  }
  const payload = JSON.parse(`${message.payload}`);

  if (payload?.status == "successful" || payload?.status == "failed") {
    // clear message
    output.push({
      topic: message.topic,
      retained: true,
      payload: "",
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
    timestamp: message.timestamp,
    topic: [
      tedgeTopic,
      "cmd",
      cloudPayload.type,
      buildCommandID(cloud_prefix, message),
    ].join("/"),
    payload: JSON.stringify(payload),
  });
  return messages;
}

function buildCommandID(cloudPrefix: string, message: Message): string {
  return [cloudPrefix, message.timestamp.seconds].join("-");
}

export function onMessage(message: Message, config: Config | undefined = {}) {
  const { cloud_prefix = "azeg", commands = ["writeSetpoint"] } = config;
  if (isTedgeCommandStatus(cloud_prefix, message.topic)) {
    return handleCommandUpdate(message);
  }

  // map a cloud message to a local tedge command based on the .type
  const output = [];
  const payload = JSON.parse(message.payload);
  if (commands.includes(payload.type)) {
    output.push(...createCommand(message, payload, config));
  }
  return output;
}
