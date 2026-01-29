import { Message, Context } from "../../common/tedge";
import { handleThinEdgeCommand } from "./thinedge-command-handler";
import { handleThingsBoardTopic } from "./thingsboard-rpc-handler";
import { getDeviceName } from "./utils";

export interface Config {
  // TODO: remove it once it is able to access to the main device name
  main_device_name?: string;
}

export interface FlowContext extends Context {
  config: Config;
}

export function onMessage(message: Message, context: FlowContext) {
  const { main_device_name = "MAIN" } = context.config;
  const topic = message.topic;
  const payload = message.payload;

  // Ignore empty messages (cleared retained messages)
  if (payload.length === 0) {
    return [];
  }

  // Handle ThingsBoard RPC requests
  if (topic.startsWith("tb/")) {
    return handleThingsBoardTopic(topic, payload, main_device_name);
  }

  const parts = topic.split("/");
  const [root, seg1, seg2, seg3, seg4, channel, type, cmdId] = parts;
  const entityId = `${seg1}/${seg2}/${seg3}/${seg4}`;
  const deviceName = getDeviceName(entityId, main_device_name);

  // Handle thin-edge command
  if (channel === "cmd") {
    return handleThinEdgeCommand(payload, deviceName, cmdId, main_device_name);
  }

  // Not an RPC or command message
  return [];
}
