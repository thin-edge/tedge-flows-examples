import { Message, Context } from "../../common/tedge";
import { convertDeviceRegistration } from "./registration";

export interface Config {
  // TODO: remove `main_device_name` once it is able to access to the main device name
  main_device_name?: string;
  // Default device profile name applied if `type` is not given in the payload
  default_device_profile?: string;
  // MAX number of the pending messages
  max_pending_messages?: number;
}

export interface FlowContext extends Context {
  config: Config;
}

export interface RegistrationPayload {
  // All keys starting with '@' are reserved keys by thin-edge.io
  "@parent"?: string;
  "@type"?: string;
  "@id"?: string;
  // If 'name' is given in the registration payload, it will be used as the ThingsBoard device name
  name?: string;
  // If 'type' is given in the registration payload, it will be used as the ThingsBoard device profile
  type?: string;
  // All other key-values
  [key: string]: any;
}

const INTERNAL_TOPIC_ROOT = "tbflow";

// Prefix for <(key: entity ID), (value: device name)> store
const ENTITY_TO_NAME_PREFIX = "tb-entity-to-name:";
// Prefix for <(key: device name), (value: entity ID)> store
const NAME_TO_ENTITY_PREFIX = "tb-name-to-entity:";
// Prefix for <(key: entity ID), (value:pending messages)> store
const MSG_PREFIX = "tb-msg:";

export function onMessage(message: Message, context: FlowContext): Message[] {
  const {
    main_device_name = "MAIN",
    default_device_profile = "default",
    max_pending_messages = 100,
  } = context.config;

  // It would be good if we have `onStartup` hook to initialize the main device
  initializeMainDevice(context, main_device_name);

  const { entityId, topicSegments } = parseTopicSegments(message.topic);
  const lookupKey = `${ENTITY_TO_NAME_PREFIX}${entityId}`;
  const pendingMsgKey = `${MSG_PREFIX}${entityId}`;

  // Device already registered - forward to internal topic
  if (context.mapper.get(lookupKey)) {
    return forwardMessageToInternalTopic(message);
  }

  let payload;
  try {
    payload = parsePayload(message);
  } catch (error) {
    console.error(error);
    return [];
  }

  const deviceName =
    payload.name || generateDeviceName(entityId, main_device_name);
  const reverseLookupKey = `${NAME_TO_ENTITY_PREFIX}${deviceName}`;

  // Registration message (5 segments: te/device/id/service/name)
  if (topicSegments.length == 5) {
    // The Gateway device should be already registered
    if (entityId === "device/main//") {
      return [];
    }

    let output: Message[] = [];
    // Convert the registration message to ThingsBoard messages
    output = output.concat(
      convertDeviceRegistration(payload, deviceName, default_device_profile),
    );

    // Take out pending messages if any
    const pendingMessages = context.mapper.get(pendingMsgKey) || [];
    output = output.concat(pendingMessages);
    context.mapper.set(pendingMsgKey, []);

    // Add the device name into mapper key-value store
    context.mapper.set(lookupKey, deviceName);
    context.mapper.set(reverseLookupKey, entityId);

    return output;
  }

  // Non-registration message - store as pending message
  storePendingMessage(context, max_pending_messages, pendingMsgKey, message);

  return [];
}

// The registration message for the main device is not always published,
// hence add it to the KV store here
function initializeMainDevice(
  context: FlowContext,
  mainDeviceName: string,
): void {
  const lookupKey = `${ENTITY_TO_NAME_PREFIX}device/main//`;
  const reverseLookupKey = `${NAME_TO_ENTITY_PREFIX}${mainDeviceName}`;

  if (!context.mapper.get(lookupKey)) {
    context.mapper.set(lookupKey, mainDeviceName);
    context.mapper.set(reverseLookupKey, "device/main//");
  }
}

function parseTopicSegments(topic: string): {
  entityId: string;
  topicSegments: string[];
} {
  const topicSegments = topic.split("/");
  const [_te, device, deviceId, service, serviceName] = topicSegments;
  const entityId = `${device}/${deviceId}/${service}/${serviceName}`;
  return { entityId, topicSegments };
}

// Republishes to the ThingsBoard flow internal topic
function forwardMessageToInternalTopic(message: Message): Message[] {
  return [
    {
      time: message.time,
      topic: message.topic.replace(/^te\//, `${INTERNAL_TOPIC_ROOT}/`),
      payload: message.payload,
    },
  ];
}

// If payload doesn't contain a explicit `name`, this name generation logic will be applied.
function generateDeviceName(entityId: string, mainName: string): string {
  if (entityId === "device/main//") {
    return mainName;
  }

  const segments = entityId.split("/").filter((segment) => segment.length > 0);
  return `${mainName}:${segments.join(":")}`;
}

// Change the internal topic root from `te` to `tbflow`
// This tells other flows that the incoming messages are for already registered devices
function storePendingMessage(
  context: FlowContext,
  maxNum: number,
  key: string,
  message: Message,
): void {
  const messages = context.mapper.get(key) || [];
  messages.push({
    topic: message.topic.replace(/^te\//, `${INTERNAL_TOPIC_ROOT}/`),
    payload: message.payload,
  });
  if (messages.length > maxNum) messages.shift();
  context.mapper.set(key, messages);
}

// Helper function to safely parse payload
function parsePayload(message: Message): any {
  const payload = message.payload.trim();

  // Handle empty payload (retained message cleared)
  if (payload.length === 0) return {};

  // Handle the health status corner case
  if (message.topic.endsWith("/status/health")) {
    if (payload === "0") return { status: "down" };
    if (payload === "1") return { status: "up" };
  }

  // Default: parse as JSON
  try {
    return JSON.parse(payload);
  } catch (error) {
    // Throw error instead of returning empty object
    throw new Error(
      `Failed to parse payload for topic ${message.topic}: ${error}`,
    );
  }
}
