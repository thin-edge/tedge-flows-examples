import { Message, Context } from "../../common/tedge";
import { convertMeasurementToTelemetry } from "./converters/measurement";
import { convertTwinToAttribute } from "./converters/twin";
import { convertAlarmToTelemetry } from "./converters/alarm";
import { convertEventToTelemetry } from "./converters/event";
import { convertCommandResponseToRpc } from "./converters/command";
import { handleThingsBoardTopic } from "./converters/command";
import { getDeviceName } from "./utils";

export interface Config {
  main_device_name?: string;
  add_type_to_key?: boolean;
  alarm_prefix?: string;
  event_prefix?: string;
}
export interface FlowContext extends Context {
  config: Config;
}

export function onMessage(message: Message, context: FlowContext) {
  const {
    main_device_name = "MAIN",
    add_type_to_key = true,
    alarm_prefix = "",
    event_prefix = "",
  } = context.config;
  const payload = message.payload;
  const topic = message.topic;

  // Check if it's a ThingsBoard topic
  if (topic.startsWith("tb/")) {
    return handleThingsBoardTopic(topic, payload, main_device_name);
  }

  const parts = topic.split("/");
  const [root, seg1, seg2, seg3, seg4, channel, type, cmdId] = parts;
  const entityId = `${seg1}/${seg2}/${seg3}/${seg4}`;

  const deviceName = getDeviceName(entityId, main_device_name);
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
    case "cmd":
      return convertCommandResponseToRpc(
        payload,
        deviceName,
        cmdId,
        main_device_name,
      );
    default:
      return [];
  }
}
