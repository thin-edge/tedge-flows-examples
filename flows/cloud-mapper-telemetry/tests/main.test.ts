import { expect, test, describe } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as testing from "../../common/testing";
import * as flow from "../src/main";

describe("measurement conversions", () => {
  test("Single value", () => {
    const output = flow.onMessage({
      timestamp: tedge.mockGetTime(new Date("2025-01-01").getTime()),
      topic: "te/device/child1///m/example",
      payload: JSON.stringify({
        temperature: 23.0,
      }),
    });
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("azeg/DDATA/device_child1");
    const payload = JSON.parse(output[0].payload);
    expect(payload).toEqual({
      timestamp: "2025-01-01T00:00:00.000Z",
      uuid: "device_child1",
      metrics: [
        {
          name: "temperature",
          value: 23.0,
          timestamp: "2025-01-01T00:00:00.000Z",
        },
      ],
    });
  });

  test("Multiple values with mixed levels", () => {
    const output = flow.onMessage({
      timestamp: tedge.mockGetTime(new Date("2025-01-01").getTime()),
      topic: "te/device/child-other-2///m/example",
      payload: JSON.stringify({
        temperature: 23.0,
        sensor: {
          humidity: 90,
        },
      }),
    });
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("azeg/DDATA/device_child-other-2");
    const payload = JSON.parse(output[0].payload);
    expect(payload).toEqual({
      timestamp: "2025-01-01T00:00:00.000Z",
      uuid: "device_child-other-2",
      metrics: [
        {
          name: "temperature",
          value: 23.0,
          timestamp: "2025-01-01T00:00:00.000Z",
        },
        {
          name: "sensor_humidity",
          timestamp: "2025-01-01T00:00:00.000Z",
          value: 90,
        },
      ],
    });
  });
});

describe("tedge-flows tests", () => {
  test("Single value", () => {
    if (!testing.isTedgeAvailable()) {
      console.log("WARN: skipped because tedge binary is not available");
      return;
    }
    const output = testing.runCommand(__dirname, {
      timestamp: tedge.mockGetTime(),
      topic: "te/device/child-1///m/hello",
      payload: JSON.stringify({
        temperature: 23.0,
      }),
    });

    let payload = JSON.parse(output.payload);
    // TODO: replace this once the tedge-flows test command allows the user to provide a fixed timestamp
    payload = testing.replaceTimestamps(
      payload,
      "timestamp",
      "2025-01-01T00:00:00.000Z",
    );

    expect(payload).toEqual({
      timestamp: "2025-01-01T00:00:00.000Z",
      uuid: "device_child-1",
      metrics: [
        {
          name: "temperature",
          value: 23.0,
          timestamp: "2025-01-01T00:00:00.000Z",
        },
      ],
    });
  });
});
