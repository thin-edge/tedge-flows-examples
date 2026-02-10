import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

jest.useFakeTimers();

describe("Map Main Device Events to Device Me Telemetry API", () => {
  let context: tedge.Context;

  beforeEach(() => {
    context = tedge.createContext({
      main_device_name: "PROD_GATEWAY",
      add_type_to_key: true,
      event_prefix: "event::",
    });

    // mapper KV store should know the main device's name
    context.mapper.set("tb-entity-to-name:device/main//", "PROD_GATEWAY");
  });

  test("input with timestamp", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main///e/login_event",
      payload: JSON.stringify({
        text: "A user just logged in",
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

    expect(output[0].topic).toBe("tb/me/telemetry");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      ts: 1602739847000,
      values: {
        "event::login_event": {
          text: "A user just logged in",
          someOtherCustomFragment: {
            nested: {
              value: "extra info",
            },
          },
        },
      },
    });
  });

  test("Do not add timestamp when it is missing", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main///e/login_event",
      payload: JSON.stringify({
        text: "A user just logged in",
      }),
    };

    context.config.event_prefix = "";

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/me/telemetry");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      login_event: {
        text: "A user just logged in",
      },
    });
  });
});

describe("Map Child/Service Events to Gateway Telemetry API", () => {
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
      topic: "tbflow/device/child0///e/login_event",
      payload: JSON.stringify({
        text: "A user just logged in",
      }),
    };

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/gateway/telemetry");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      CHILD_0: [
        {
          login_event: {
            text: "A user just logged in",
          },
        },
      ],
    });
  });

  test("child device with timestamp", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/child0///e/login_event",
      payload: JSON.stringify({
        text: "A user just logged in",
        time: 1602739847.0,
      }),
    };

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/gateway/telemetry");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      CHILD_0: [
        {
          ts: 1602739847000,
          values: {
            login_event: {
              text: "A user just logged in",
            },
          },
        },
      ],
    });
  });

  test("service", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tbflow/device/main/service/app1/e/login_event",
      payload: JSON.stringify({
        text: "A user just logged in",
      }),
    };

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("tb/gateway/telemetry");

    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      APP_1: [
        {
          login_event: {
            text: "A user just logged in",
          },
        },
      ],
    });
  });
});
