import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

jest.useFakeTimers();

describe("Map Alarms to Telemetry", () => {
  test("Convert an active alarm", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///a/temperature_high",
      payload: JSON.stringify({
        severity: "major",
        text: "Temperature is very high",
        time: 1602739847.0,
        someOtherCustomFragment: {
          nested: {
            value: "extra info",
          },
        },
      }),
    };
    const context = tedge.createContext({
      main_device_name: "PROD_GATEWAY",
      add_type_to_key: true,
      alarm_prefix: "alarm::",
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      PROD_GATEWAY: [
        {
          ts: 1602739847000,
          values: {
            "alarm::temperature_high": {
              status: "active",
              severity: "major",
              text: "Temperature is very high",
              someOtherCustomFragment: {
                nested: {
                  value: "extra info",
                },
              },
            },
          },
        },
      ],
    });
  });

  test("Convert an empty JSON to an active alarm", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///a/temperature_high",
      payload: JSON.stringify({}),
    };
    const context = tedge.createContext({
      main_device_name: "PROD_GATEWAY",
      add_type_to_key: true,
      alarm_prefix: "alarm::",
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      PROD_GATEWAY: [
        {
          "alarm::temperature_high": {
            status: "active",
          },
        },
      ],
    });
  });

  test("Convert a cleared alarm", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///a/temperature_high",
      payload: "",
    };
    const context = tedge.createContext({
      main_device_name: "PROD_GATEWAY",
      add_type_to_key: true,
      alarm_prefix: "alarm::",
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      PROD_GATEWAY: [
        {
          "alarm::temperature_high": {
            status: "cleared",
          },
        },
      ],
    });
  });

  test("Do not add timestamp when it is missing", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///a/temperature_high",
      payload: JSON.stringify({
        severity: "major",
        text: "Temperature is very high",
      }),
    };
    const context = tedge.createContext({
      main_device_name: "PROD_GATEWAY",
      add_type_to_key: true,
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      PROD_GATEWAY: [
        {
          temperature_high: {
            status: "active",
            severity: "major",
            text: "Temperature is very high",
          },
        },
      ],
    });
  });
});
