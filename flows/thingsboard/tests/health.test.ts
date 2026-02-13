import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

jest.useFakeTimers();

describe("Map Service Health Status to ThingsBoard Telemetry", () => {
  let context: tedge.Context;

  beforeEach(() => {
    context = tedge.createContext({
      main_device_name: "PROD_GATEWAY",
    });

    // mapper KV store should know the main device's name
    context.mapper.set("tb-entity-to-name:device/main//", "PROD_GATEWAY");
    context.mapper.set(
      "tb-entity-to-name:device/main/service/c8y-firmware-plugin",
      "C8Y_FIRMWARE_PLUGIN",
    );
    context.mapper.set(
      "tb-entity-to-name:device/main/service/mosquitto-things-bridge",
      "MOSQUITTO_THINGS_BRIDGE",
    );
    context.mapper.set(
      "tb-entity-to-name:device/sensor-001/service/telemetry-plugin",
      "TELEMETRY_PLUGIN",
    );
    context.mapper.set("tb-entity-to-name:device/main/service/app1", "APP_1");
  });

  test("normal health status for main device service", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main/service/c8y-firmware-plugin/status/health",
      payload: JSON.stringify({
        pid: 128,
        status: "up",
        time: 1770717141.5398614,
      }),
    };

    const output = flow.onMessage(message, context);

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("tb/gateway/telemetry");

    const payload = JSON.parse(output[0].payload);

    expect(payload).toStrictEqual({
      C8Y_FIRMWARE_PLUGIN: [
        {
          ts: 1770717141539,
          values: {
            "health::status": "up",
            "health::pid": 128,
          },
        },
      ],
    });
  });

  test("mosquitto bridge health status - up (1)", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main/service/mosquitto-things-bridge/status/health",
      payload: "1",
      raw_payload: new Uint8Array([1]),
    };

    const output = flow.onMessage(message, context);

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("tb/gateway/telemetry");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      MOSQUITTO_THINGS_BRIDGE: [
        {
          "health::status": "up",
        },
      ],
    });
  });

  test("mosquitto bridge health status - down (0)", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main/service/mosquitto-things-bridge/status/health",
      payload: "0",
      raw_payload: new Uint8Array([0]),
    };

    const output = flow.onMessage(message, context);

    expect(output).toHaveLength(1);

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      MOSQUITTO_THINGS_BRIDGE: [
        {
          "health::status": "down",
        },
      ],
    });
  });

  test("health status for child device service", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/sensor-001/service/telemetry-plugin/status/health",
      payload: JSON.stringify({
        pid: 256,
        status: "up",
        time: 1770717200.123,
      }),
    };

    const output = flow.onMessage(message, context);

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("tb/gateway/telemetry");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      TELEMETRY_PLUGIN: [
        {
          ts: 1770717200123,
          values: {
            "health::status": "up",
            "health::pid": 256,
          },
        },
      ],
    });
  });

  test("health status with additional custom fields", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main/service/c8y-firmware-plugin/status/health",
      payload: JSON.stringify({
        pid: 999,
        status: "up",
        time: 1770717141.5,
        memory_usage: 45.6,
        cpu_usage: 12.3,
        uptime: 86400,
      }),
    };

    const output = flow.onMessage(message, context);

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      C8Y_FIRMWARE_PLUGIN: [
        {
          ts: 1770717141500,
          values: {
            "health::status": "up",
            "health::pid": 999,
            "health::memory_usage": 45.6,
            "health::cpu_usage": 12.3,
            "health::uptime": 86400,
          },
        },
      ],
    });
  });

  test("health status without timestamp", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main/service/app1/status/health",
      payload: JSON.stringify({
        pid: 555,
        status: "up",
      }),
    };

    const output = flow.onMessage(message, context);

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      APP_1: [
        {
          "health::status": "up",
          "health::pid": 555,
          // Omit health::timestamp here; toStrictEqual will fail if it exists.
        },
      ],
    });
  });

  test("returns empty array for invalid health topic", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main/service/invalid",
      payload: JSON.stringify({ status: "up" }),
    };

    const output = flow.onMessage(message, context);

    expect(output).toEqual([]);
  });

  test("returns empty array for invalid number payload", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main/service/test/status/health",
      payload: "5", // invalid, only 0 or 1
      raw_payload: new Uint8Array([5]),
    };

    const output = flow.onMessage(message, context);

    expect(output).toEqual([]);
  });

  test("returns empty array for invalid string payload", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main/service/test/status/health",
      payload: "invalid", // String that doesn't parse to valid JSON
    };

    const output = flow.onMessage(message, context);

    expect(output).toEqual([]);
  });

  test("returns empty array for null payload", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main/service/test/status/health",
      payload: null as any,
    };

    const output = flow.onMessage(message, context);

    expect(output).toEqual([]);
  });
});

describe("Health Status Edge Cases", () => {
  let context: tedge.Context;

  beforeEach(() => {
    context = tedge.createContext({
      main_device_name: "PROD_GATEWAY",
    });

    // mapper KV store should know the main device's name
    context.mapper.set("tb-entity-to-name:device/main//", "PROD_GATEWAY");
    context.mapper.set("tb-entity-to-name:device/main/service/app1", "APP_1");
  });

  test("handles status field as unknown when missing", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main/service/app1/status/health",
      payload: JSON.stringify({
        pid: 100,
        time: 1770717141.5,
      }),
    };

    const output = flow.onMessage(message, context);

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      APP_1: [
        {
          ts: 1770717141500,
          values: {
            "health::pid": 100,
            "health::status": "unknown",
          },
        },
      ],
    });
  });

  test("preserves custom status values", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main/service/app1/status/health",
      payload: JSON.stringify({
        status: "degraded",
        pid: 100,
      }),
    };

    const output = flow.onMessage(message, context);

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      APP_1: [
        {
          "health::pid": 100,
          "health::status": "degraded",
        },
      ],
    });
  });
});
