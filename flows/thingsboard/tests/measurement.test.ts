import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

jest.useFakeTimers();

describe("Map Measurements to Telemetry", () => {
  test("[main] should add type to key", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///m/sensor",
      payload: JSON.stringify({
        temperature: 10,
      }),
    };
    const context = tedge.createContext({
      main_device_name: "PROD_GATEWAY",
      add_type_to_key: true,
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    // Main device uses tb/me/telemetry topic
    expect(output[0].topic).toBe("tb/me/telemetry");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      "sensor::temperature": 10,
    });
  });

  test("[main] should convert timestamp", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///m/sensor",
      payload: JSON.stringify({
        temperature: 10,
        time: 1602739847.0,
      }),
    };
    const context = tedge.createContext({
      main_device_name: "PROD_GATEWAY",
      add_type_to_key: true,
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/me/telemetry");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      ts: 1602739847000,
      values: {
        "sensor::temperature": 10,
      },
    });
  });

  test("[child] should not add type due to config", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/child1///m/sensor",
      payload: JSON.stringify({
        temperature: 10,
      }),
    };
    const context = tedge.createContext({
      add_type_to_key: false,
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      "MAIN:device:child1": [
        {
          temperature: 10,
        },
      ],
    });
  });

  test("[service] should not add type due to lacking type in topic", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/child1/service/app1/m/",
      payload: JSON.stringify({
        temperature: 10,
      }),
    };
    const context = tedge.createContext();
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      "MAIN:device:child1:service:app1": [
        {
          temperature: 10,
        },
      ],
    });
  });
});
