import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

jest.useFakeTimers();

describe("Map Main Device Measurements to Device Me Telemetry API", () => {
  let context: tedge.Context;

  beforeEach(() => {
    context = tedge.createContext({
      main_device_name: "PROD_GATEWAY",
      add_type_to_key: true,
    });

    // mapper KV store should know the main device's name
    context.mapper.set("tb-entity-to-name:device/main//", "PROD_GATEWAY");
  });

  test("should add type to key", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main///m/sensor",
      payload: JSON.stringify({
        temperature: 10,
      }),
    };

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/me/telemetry");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      "sensor::temperature": 10,
    });
  });

  test("should not add type to key", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main///m/sensor",
      payload: JSON.stringify({
        temperature: 10,
      }),
    };
    context.config.add_type_to_key = false;
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/me/telemetry");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      temperature: 10,
    });
  });

  test("should not add type to key when type is missing in topic", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main///m/",
      payload: JSON.stringify({
        temperature: 10,
      }),
    };
    context.config.add_type_to_key = false;
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/me/telemetry");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      temperature: 10,
    });
  });

  test("should convert timestamp to millisecond", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main///m/sensor",
      payload: JSON.stringify({
        temperature: 10,
        time: 1602739847.0,
      }),
    };

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
});

describe("Map Child/Service Measurements to Gateway Telemetry API", () => {
  let context: tedge.Context;

  beforeEach(() => {
    context = tedge.createContext({
      main_device_name: "PROD_GATEWAY",
      add_type_to_key: true,
    });

    // Preregister device name to mapper KV store
    context.mapper.set("tb-entity-to-name:device/main//", "PROD_GATEWAY");
    context.mapper.set("tb-entity-to-name:device/child1//", "CHILD_1");
    context.mapper.set("tb-entity-to-name:device/child1/service/app1", "APP_1");
  });

  test("child device without timestamp", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/child1///m/sensor",
      payload: JSON.stringify({
        temperature: 10,
      }),
    };
    context.config.add_type_to_key = false;

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/gateway/telemetry");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      CHILD_1: [
        {
          temperature: 10,
        },
      ],
    });
  });

  test("child device with timestamp", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/child1///m/sensor",
      payload: JSON.stringify({
        temperature: 10,
        time: 1602739847.0,
      }),
    };
    context.config.add_type_to_key = false;

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/gateway/telemetry");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      CHILD_1: [
        {
          ts: 1602739847000,
          values: {
            temperature: 10,
          },
        },
      ],
    });
  });

  test("service", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/child1/service/app1/m/",
      payload: JSON.stringify({
        temperature: 10,
      }),
    };

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/gateway/telemetry");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      APP_1: [
        {
          temperature: 10,
        },
      ],
    });
  });
});
