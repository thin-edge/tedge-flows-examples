import { Message } from "../../common/tedge";

export function formatTelemetryMessage(
  deviceName: string,
  telemetryEntry: any,
  isMain: boolean,
  time: Date = new Date(),
): Message[] {
  if (isMain) {
    // For main device: use tb/me/telemetry with simpler payload
    return [
      {
        time,
        topic: "tb/me/telemetry",
        payload: JSON.stringify(telemetryEntry),
      },
    ];
  } else {
    // For child devices: use tb/gateway/telemetry with device name wrapper
    return [
      {
        time,
        topic: "tb/gateway/telemetry",
        payload: JSON.stringify({
          [deviceName]: [telemetryEntry],
        }),
      },
    ];
  }
}
