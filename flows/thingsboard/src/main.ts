import { Message, Context } from "../../common/tedge";

export interface Config {
  main_device_name?: string;
  add_type_to_key?: boolean;
}
export interface FlowContext extends Context {
  config: Config;
}

export function onMessage(message: Message, context: FlowContext) {
  const { main_device_name = "MAIN", add_type_to_key = true } = context.config;
  const payload = message.payload;
  const parts = message.topic.split("/");
  const [root, seg1, seg2, seg3, seg4, channel, type] = parts;
  const entityId = `${seg1}/${seg2}/${seg3}/${seg4}`;

  const deviceName = getDeviceName(entityId, main_device_name);
  const shouldTransform = (add_type_to_key && type.length > 0) || false;

  switch (channel) {
    case "m":
      return convertMeasurementToTelemetry(
        shouldTransform,
        payload,
        deviceName,
        type,
      );
    case "twin":
      return convertTwinToAttribute(shouldTransform, payload, deviceName, type);
    default:
      return [];
  }
}

function getDeviceName(entityId: string, mainName: string): string {
  if (entityId === "device/main//") {
    return mainName;
  }
  const segments = entityId.split("/").filter((segment) => segment.length > 0);
  return `${mainName}:${segments.join(":")}`;
}

function convertMeasurementToTelemetry(
  shouldTransform: boolean,
  payload: string,
  deviceName: string,
  type: string,
) {
  const originalData = JSON.parse(payload);

  // Need to convert unix timestamp in millisecond
  const rawTime = originalData["time"];
  const timestamp = rawTime ? Math.round(Number(rawTime) * 1000) : null;
  const { time, ...dataWithoutTime } = originalData;

  // Prefix type to key (don't add it to time!)
  const telemetryValues = shouldTransform
    ? Object.fromEntries(
        Object.entries(dataWithoutTime).map(([key, val]) => [
          key === "ts" ? key : `${type}::${key}`,
          val,
        ]),
      )
    : dataWithoutTime;

  const telemetryEntry = timestamp
    ? {
        ts: timestamp,
        values: telemetryValues,
      }
    : telemetryValues;

  return [
    {
      topic: "tb/gateway/telemetry",
      payload: JSON.stringify({
        [deviceName]: [telemetryEntry],
      }),
    },
  ];
}

function convertTwinToAttribute(
  shouldTransform: boolean,
  payload: string,
  deviceName: string,
  type: string,
) {
  let attributesData: Record<string, any> = {};

  try {
    const parsedValue = JSON.parse(payload);

    if (parsedValue !== null && typeof parsedValue == "object") {
      // Remove "time" key
      const { time, ...dataWithoutTime } = parsedValue;

      if (shouldTransform) {
        attributesData = Object.fromEntries(
          Object.entries(dataWithoutTime).map(([key, val]) => [
            `${type}::${key}`,
            val,
          ]),
        );
      } else {
        attributesData = dataWithoutTime;
      }
    } else {
      // JSON, but primitive value
      attributesData = { [type]: parsedValue };
    }
  } catch (e) {
    // if payload is not JSON
    attributesData = { [type]: payload };
  }

  return [
    {
      topic: "tb/gateway/attributes",
      payload: JSON.stringify({
        [deviceName]: attributesData,
      }),
    },
  ];
}
