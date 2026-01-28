export function convertMeasurementToTelemetry(
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
