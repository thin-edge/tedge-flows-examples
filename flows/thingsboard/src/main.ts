import { Message, Context } from "../../common/tedge";
import { convertMeasurementToTelemetry } from "./converters/measurement";
import { convertTwinToAttribute } from "./converters/twin";
import { convertAlarmToTelemetry } from "./converters/alarm";
import { convertEventToTelemetry } from "./converters/event";
import { formatTelemetryMessage } from "./utils";
import { convertHealthToTelemetry } from "./converters/health";

export interface Config {
  add_type_to_key?: boolean;
  alarm_prefix?: string;
  event_prefix?: string;
  enable_heartbeat?: boolean;
}
export interface FlowContext extends Context {
  config: Config;
}

const ENTITY_TO_NAME_PREFIX = "tb-entity-to-name:";
// This prefix is used to store the service health status
export const ENTITY_TO_HEALTH_STATUS_PREFIX = "tb-health:";

export function onMessage(message: Message, context: FlowContext) {
  const {
    add_type_to_key = true,
    alarm_prefix = "",
    event_prefix = "",
  } = context.config;
  const payload = message.payload;
  const parts = message.topic.split("/");
  const [root, device, deviceId, service, serviceName, channel, type = ""] =
    parts;
  const entityId = `${device}/${deviceId}/${service}/${serviceName}`;
  const regKey = `${ENTITY_TO_NAME_PREFIX}${entityId}`;

  if (!context.mapper.get(regKey)) {
    console.error(
      "Entity should have been registered by 'thingsboard-registration flow':",
      entityId,
    );
    return [];
  }
  const deviceName = context.mapper.get(regKey);

  const isMain = entityId === "device/main//";
  const shouldTransform = (add_type_to_key && type.length > 0) || false;

  switch (channel) {
    case "m":
      return convertMeasurementToTelemetry(
        shouldTransform,
        payload,
        deviceName,
        type,
        isMain,
      );
    case "twin":
      return convertTwinToAttribute(
        shouldTransform,
        payload,
        deviceName,
        type,
        isMain,
      );
    case "a":
      return convertAlarmToTelemetry(
        payload,
        deviceName,
        type,
        alarm_prefix,
        isMain,
      );
    case "e":
      return convertEventToTelemetry(
        payload,
        deviceName,
        type,
        event_prefix,
        isMain,
      );
    case "status":
      if (type === "health") {
        return convertHealthToTelemetry(
          context,
          payload,
          deviceName,
          entityId,
          isMain,
        );
      } else {
        return [];
      }
    default:
      return [];
  }
}

// Sending a heartbeat with interval
export function onInterval(time: Date, context: FlowContext) {
  let output: Message[] = [];

  const { enable_heartbeat = true } = context.config;
  if (!enable_heartbeat) return [];

  for (const maybeHealthEntityId of context.script.keys()) {
    if (maybeHealthEntityId.startsWith(ENTITY_TO_HEALTH_STATUS_PREFIX)) {
      // Periodically update the health status telemetry for each entity that has health status in script KV store
      const entityId = maybeHealthEntityId.replace(
        ENTITY_TO_HEALTH_STATUS_PREFIX,
        "",
      );
      const healthStatus = context.script.get(maybeHealthEntityId);
      const deviceName = context.mapper.get(
        `${ENTITY_TO_NAME_PREFIX}${entityId}`,
      );
      const telemetryEntry = { "health::status": healthStatus };
      output.push(
        ...formatTelemetryMessage(
          deviceName,
          telemetryEntry,
          entityId === "device/main//",
          time,
        ),
      );
    }
  }

  const mainDeviceName = context.mapper.get(
    `${ENTITY_TO_NAME_PREFIX}device/main//`,
  );
  const mainTelemetryEntry = { heartbeat: 1 };
  output.push(
    ...formatTelemetryMessage(mainDeviceName, mainTelemetryEntry, true, time),
  );

  return output;
}
