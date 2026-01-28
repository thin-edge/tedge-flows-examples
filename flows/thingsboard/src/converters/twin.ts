export function convertTwinToAttribute(
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
