import { formatTelemetryMessage } from "../utils";

export function convertEventToTelemetry(
  payload: string,
  deviceName: string,
  type: string,
  eventPrefix: string,
  isMain: boolean,
) {
  const originalData = JSON.parse(payload);
  const { time, ...dataWithoutTime } = originalData;

  const rawTime = originalData["time"];
  const timestamp = rawTime ? Math.round(Number(rawTime) * 1000) : null;

  const telemetryEntry = timestamp
    ? {
        ts: timestamp,
        values: {
          [`${eventPrefix}${type}`]: dataWithoutTime,
        },
      }
    : {
        [`${eventPrefix}${type}`]: dataWithoutTime,
      };

  return formatTelemetryMessage(deviceName, telemetryEntry, isMain);
}
