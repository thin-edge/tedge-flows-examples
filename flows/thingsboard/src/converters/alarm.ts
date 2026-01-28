export function convertAlarmToTelemetry(
  payload: string,
  deviceName: string,
  type: string,
  alarmPrefix: string,
) {
  let telemetryEntry: Record<string, any> = {};

  if (payload.length === 0) {
    telemetryEntry = {
      [`${alarmPrefix}${type}`]: { status: "cleared" },
    };
  } else {
    const originalData = JSON.parse(payload);
    const { time, ...dataWithoutTime } = originalData;

    const rawTime = originalData["time"];
    const timestamp = rawTime ? Math.round(Number(rawTime) * 1000) : null;

    const telemetryValue = {
      status: "active",
      ...dataWithoutTime,
    };

    telemetryEntry = timestamp
      ? {
          ts: timestamp,
          values: {
            [`${alarmPrefix}${type}`]: telemetryValue,
          },
        }
      : {
          [`${alarmPrefix}${type}`]: telemetryValue,
        };
  }

  return [
    {
      topic: "tb/gateway/telemetry",
      payload: JSON.stringify({
        [deviceName]: [telemetryEntry],
      }),
    },
  ];
}
