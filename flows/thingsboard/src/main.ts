import { Message, Context } from "../../common/tedge";
import { convertMeasurementToTelemetry } from "./converters/measurement";
import { convertTwinToAttribute } from "./converters/twin";
import { convertAlarmToTelemetry } from "./converters/alarm";
import { convertEventToTelemetry } from "./converters/event";
import { getDeviceName } from "./utils";

export interface Config {
  // TODO: remove `main_device_name` once it is able to access to the main device name
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
  const parts = message.topic.split("/");
  const [root, seg1, seg2, seg3, seg4, channel, type] = parts;
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
    default:
      return [];
  }
}
