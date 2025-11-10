import { expect, test, describe } from "@jest/globals";
import * as testing from "../../common/testing";
import * as flow from "../src/main";
import { decodeJSON, encodeJSON } from "../../common/tedge";

describe("measurement conversions", () => {
  test("Single value", async () => {
    const output = await flow.onMessage(
      {
        time: new Date("2025-01-01"),
        topic: "te/device/child1///m/example",
        payload: encodeJSON({
          temperature: 23.0,
        }),
      },
      { config: {} },
    );
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("azeg/DDATA/device_child1");
    const payload = decodeJSON(output[0].payload);
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
    const output = flow.onMessage(
      {
        time: new Date("2025-01-01"),
        topic: "te/device/child-other-2///m/example",
        payload: encodeJSON({
          temperature: 23.0,
          sensor: {
            humidity: 90,
          },
        }),
      },
      { config: {} },
    );
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("azeg/DDATA/device_child-other-2");
    const payload = decodeJSON(output[0].payload);
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
  test.skip("Single value", () => {
    // Skip until the tedge-flows has been updated to the new format
    if (!testing.isTedgeAvailable()) {
      console.log("WARN: skipped because tedge binary is not available");
      return;
    }
    const output = testing.runCommand(__dirname, {
      time: new Date(),
      topic: "te/device/child-1///m/hello",
      payload: encodeJSON({
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
