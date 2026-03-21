import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

jest.useFakeTimers();

describe("Map Main Device Alarms to Device Me Telemetry API", () => {
  let context: tedge.Context;

  beforeEach(() => {
    context = tedge.createContext({
      main_device_name: "PROD_GATEWAY",
      add_type_to_key: true,
      alarm_prefix: "alarm::",
    });

    // mapper KV store should know the main device's name
    context.mapper.set("tb-entity-to-name:device/main//", "PROD_GATEWAY");
  });

  test("Convert an active alarm", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main///a/temperature_high",
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

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);
    const payload = tedge.decodeJsonPayload(output[0].payload);

    expect(output[0].topic).toBe("tb/me/telemetry");

    expect(payload).toStrictEqual({
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
    });
  });

  test("Convert an empty JSON to an active alarm", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main///a/temperature_high",
      payload: JSON.stringify({}),
    };

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/me/telemetry");

    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload).toStrictEqual({
      "alarm::temperature_high": {
        status: "active",
      },
    });
  });

  test("Convert a cleared alarm", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main///a/temperature_high",
      payload: "",
    };

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/me/telemetry");

    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload).toStrictEqual({
      "alarm::temperature_high": {
        status: "cleared",
      },
    });
  });

  test("Do not add timestamp when it is missing", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main///a/temperature_high",
      payload: JSON.stringify({
        severity: "major",
        text: "Temperature is very high",
      }),
    };

    context.config.alarm_prefix = "";

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/me/telemetry");

    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload).toStrictEqual({
      temperature_high: {
        status: "active",
        severity: "major",
        text: "Temperature is very high",
      },
    });
  });
});

describe("Map Child/Service Alarms to Gateway Telemetry API", () => {
  let context: tedge.Context;

  beforeEach(() => {
    context = tedge.createContext({
      main_device_name: "PROD_GATEWAY",
      add_type_to_key: true,
    });

    // Preregister device name to mapper KV store
    context.mapper.set("tb-entity-to-name:device/main//", "PROD_GATEWAY");
    context.mapper.set("tb-entity-to-name:device/child0//", "CHILD_0");
    context.mapper.set("tb-entity-to-name:device/main/service/app1", "APP_1");
  });

  test("child device without timestamp", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/child0///a/temperature_high",
      payload: JSON.stringify({
        severity: "major",
        text: "Temperature is very high",
      }),
    };

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/gateway/telemetry");

    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload).toStrictEqual({
      CHILD_0: [
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

  test("child device with timestamp", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/child0///a/temperature_high",
      payload: JSON.stringify({
        severity: "major",
        text: "Temperature is very high",
        time: 1602739847.0,
      }),
    };

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/gateway/telemetry");

    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload).toStrictEqual({
      CHILD_0: [
        {
          ts: 1602739847000,
          values: {
            temperature_high: {
              status: "active",
              severity: "major",
              text: "Temperature is very high",
            },
          },
        },
      ],
    });
  });

  test("service", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main/service/app1/a/temperature_high",
      payload: JSON.stringify({
        severity: "major",
        text: "Temperature is very high",
      }),
    };

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/gateway/telemetry");

    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload).toStrictEqual({
      APP_1: [
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
