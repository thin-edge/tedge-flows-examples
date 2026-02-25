import { Message, Context, decodePayload } from "../../common/tedge";
import { handleThinEdgeCommand } from "./thinedge-command-handler";
import { handleThingsBoardTopic } from "./thingsboard-rpc-handler";

export interface Config {}

export interface FlowContext extends Context {
  config: Config;
}

const ENTITY_TO_NAME_PREFIX = "tb-entity-to-name:";

export function onMessage(message: Message, context: FlowContext): Message[] {
  const topic = message.topic;
  const payload = decodePayload(message.payload);
  const mainDeviceName = context.mapper.get(
    `${ENTITY_TO_NAME_PREFIX}device/main//`,
  );

  // Ignore empty messages (cleared retained messages)
  if (payload.length === 0) return [];

  if (!mainDeviceName) {
    console.error(
      "Main device is not initialized. It should have been initialized by 'thingsboard-registration flow'.",
    );
    return [];
  }

  // Handle ThingsBoard RPC requests
  if (topic.startsWith("tb/")) {
    return handleThingsBoardTopic(context, topic, payload);
  }

  const parts = topic.split("/");
  const [root, seg1, seg2, seg3, seg4, channel, type, cmdId] = parts;
  const entityId = `${seg1}/${seg2}/${seg3}/${seg4}`;
  const deviceName = context.mapper.get(`${ENTITY_TO_NAME_PREFIX}${entityId}`);

  // Handle thin-edge command
  if (topic.startsWith("tbflow/") && channel === "cmd") {
    return handleThinEdgeCommand(
      topic.replace("tbflow/", "te/"),
      payload,
      deviceName,
      cmdId,
      mainDeviceName,
    );
  }

  // Not an RPC or command message
  return [];
}
