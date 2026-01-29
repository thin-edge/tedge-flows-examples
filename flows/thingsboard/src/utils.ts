export function getDeviceName(entityId: string, mainName: string): string {
  if (entityId === "device/main//") {
    return mainName;
  }
  const segments = entityId.split("/").filter((segment) => segment.length > 0);
  return `${mainName}:${segments.join(":")}`;
}

export function getEntityIdFromDeviceName(
  deviceName: string,
  mainName: string,
): string {
  if (deviceName === mainName) {
    return "device/main//";
  }

  const parts = deviceName.split(":");

  // Remove the first part (which is the device's own name prefix)
  const segments = parts.slice(1);

  // Pad with empty strings to ensure we have exactly 3 segments
  while (segments.length < 4) {
    segments.push("");
  }

  return `${segments[0]}/${segments[1]}/${segments[2]}/${segments[3]}`;
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
