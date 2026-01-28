export function getDeviceName(entityId: string, mainName: string): string {
  if (entityId === "device/main//") {
    return mainName;
  }
  const segments = entityId.split("/").filter((segment) => segment.length > 0);
  return `${mainName}:${segments.join(":")}`;
}

export function formatTelemetryMessage(
  deviceName: string,
  telemetryEntry: any,
  isMain: boolean,
) {
  if (isMain) {
    // For main device: use tb/me/telemetry with simpler payload
    return [
      {
        topic: "tb/me/telemetry",
        payload: JSON.stringify(telemetryEntry),
      },
    ];
  } else {
    // For child devices: use tb/gateway/telemetry with device name wrapper
    return [
      {
        topic: "tb/gateway/telemetry",
        payload: JSON.stringify({
          [deviceName]: [telemetryEntry],
        }),
      },
    ];
  }
}
