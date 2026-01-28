export function convertEventToTelemetry(
  payload: string,
  deviceName: string,
  type: string,
  eventPrefix: string,
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

  return [
    {
      topic: "tb/gateway/telemetry",
      payload: JSON.stringify({
        [deviceName]: [telemetryEntry],
      }),
    },
  ];
}
