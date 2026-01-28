import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

jest.useFakeTimers();

describe("Map Events to Telemetry", () => {
  test("input with timestamp", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///e/login_event",
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
    const context = tedge.createContext({
      main_device_name: "PROD_GATEWAY",
      add_type_to_key: true,
      event_prefix: "event::",
    });
    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toStrictEqual({
      PROD_GATEWAY: [
        {
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
        },
      ],
    });
  });

  test("Do not add timestamp when it is missing", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "te/device/main///e/login_event",
      payload: JSON.stringify({
        text: "A user just logged in",
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
          login_event: {
            text: "A user just logged in",
          },
        },
      ],
    });
  });
});
