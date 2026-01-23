import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

jest.useFakeTimers();

describe("Map Measurements to Telemetry", () => {
  test("should add type to key", () => {
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
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      PROD_GATEWAY: [
        {
          "sensor::temperature": 10,
        },
      ],
    });
  });

  test("should convert timestamp", () => {
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
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      PROD_GATEWAY: [
        {
          ts: 1602739847000,
          values: {
            "sensor::temperature": 10,
          },
        },
      ],
    });
  });

  test("should not add type due to config", () => {
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

  test("Should not add type due to lacking type in topic", () => {
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

describe("Map Twin to Attributes", () => {
  test("should remove timestamp", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///twin/software",
      payload: JSON.stringify({
        os: "debian",
        version: "bullseye",
        time: 1602739847.0,
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
      PROD_GATEWAY: {
        "software::os": "debian",
        "software::version": "bullseye",
      },
    });
  });

  test("should add type to key", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///twin/software",
      payload: JSON.stringify({
        os: "debian",
        version: "bullseye",
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
      PROD_GATEWAY: {
        "software::os": "debian",
        "software::version": "bullseye",
      },
    });
  });

  test("should not add type due to config", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/child1///twin/software",
      payload: JSON.stringify({
        os: "debian",
        version: "bullseye",
      }),
    };
    const context = tedge.createContext({
      add_type_to_key: false,
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      "MAIN:device:child1": {
        os: "debian",
        version: "bullseye",
      },
    });
  });

  test("Should not add type due to lacking type in topic", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/child1/service/app1/twin/",
      payload: JSON.stringify({
        os: "debian",
        version: "bullseye",
      }),
    };
    const context = tedge.createContext();
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      "MAIN:device:child1:service:app1": {
        os: "debian",
        version: "bullseye",
      },
    });
  });

  test("Should accept string payload", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/child1/service/app1/twin/os",
      payload: "debian",
    };
    const context = tedge.createContext();
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      "MAIN:device:child1:service:app1": {
        os: "debian",
      },
    });
  });

  test("Should accept boolean payload", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/child1/service/app1/twin/isActive",
      payload: "true",
    };
    const context = tedge.createContext();
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      "MAIN:device:child1:service:app1": {
        isActive: true,
      },
    });
  });
});

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

  test("Convert a cleared alarm", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///a/temperature_high",
      payload: JSON.stringify({
        time: 1602739847.0,
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
          ts: 1602739847000,
          values: {
            "alarm::temperature_high": {
              status: "cleared",
            },
          },
        },
      ],
    });
  });

  test("Do not add timestamp when it is missing", () => {
    const now = 1602739847000;
    jest.setSystemTime(now);
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
          "alarm::temperature_high": {
            status: "active",
            severity: "major",
            text: "Temperature is very high",
          },
        },
      ],
    });
  });
});
