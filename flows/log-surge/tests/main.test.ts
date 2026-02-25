import { expect, test, beforeEach, describe } from "@jest/globals";
import * as flow from "../src/main";
import * as journald from "../src/journald";
import * as tedge from "../../common/tedge";

test("Config with_logs returns the log entries", () => {
  const context = tedge.createContext({
    with_logs: true,
  });
  const message: tedge.Message = {
    time: tedge.mockGetTime(),
    topic: "dummy",
    payload: JSON.stringify(<journald.JOURNALD_RAW_MESSAGE>{
      _SOURCE_REALTIME_TIMESTAMP: "1751468051367349",
      MESSAGE: "example",
    }),
  };
  const output1 = flow.onMessage(message, context);
  expect(output1).toHaveLength(1);

  const context2 = tedge.createContext({
    with_logs: false,
  });
  const output2 = flow.onMessage(message, context2);
  expect(output2).toHaveLength(0);
});

describe.each([
  ["Some important log message", [".*(important).*"], 1],
  ["Some log message", [".*(important).*"], 0],
  ["Some log message", [], 1],
])(
  "text_filter can be used to filter log messages",
  (text: string, text_filter: string[], expected: number) => {
    test("matches the expected count", () => {
      const context = tedge.createContext({
        text_filter,
        with_logs: true,
      });
      const message: tedge.Message = {
        time: tedge.mockGetTime(),
        topic: "dummy",
        payload: JSON.stringify(<journald.JOURNALD_RAW_MESSAGE>{
          _SOURCE_REALTIME_TIMESTAMP: "1751468051367349",
          MESSAGE: text,
        }),
      };
      const output = flow.onMessage(message, context);
      expect(output).toHaveLength(expected);
    });
  },
);

test("Detect log entries with an unknown log level", () => {
  const context = tedge.createContext({});
  const output = flow.onMessage(
    {
      time: new Date(),
      topic: "",
      payload: JSON.stringify({
        _SOURCE_REALTIME_TIMESTAMP: 123456,
        MESSAGE: "example",
      }),
    },
    context,
  );
  expect(output).toHaveLength(0);

  const currentState = flow.getState(context);
  expect(currentState.stats.total).toBe(1);
  expect(currentState.stats.unknown).toBe(1);
});

describe.each([
  [
    "1751468087: Client monit-1751024993 disconnected : additional info.",
    "Client monit-1751024993 disconnected : additional info.",
  ],
  [
    "Client monit-1751024993 disconnected additional info.",
    "Client monit-1751024993 disconnected additional info.",
  ],
])("mosquitto log entry parsing", (logMessage: string, expected: string) => {
  test("Strips leading timestamp from mosquitto log messages", () => {
    const context = tedge.createContext({
      with_logs: true,
    });
    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "",
        payload: JSON.stringify(<journald.JOURNALD_RAW_MESSAGE>{
          SYSLOG_IDENTIFIER: "mosquitto",
          _SOURCE_REALTIME_TIMESTAMP: "1751468051367349",
          MESSAGE: logMessage,
        }),
      },
      context,
    );
    expect(output).toHaveLength(1);
    const message = tedge.decodeJsonPayload(output[0].payload);
    expect(message).toHaveProperty("text", expected);
    expect(message).toHaveProperty("time", 1751468051.367349);
  });
});

describe.each([
  ["WARN", <flow.Statistics>{ total: 1, warn: 1 }],
  ["WARNING", <flow.Statistics>{ total: 1, warn: 1 }],
  ["INFO", <flow.Statistics>{ total: 1, info: 1 }],
  ["ERROR", <flow.Statistics>{ total: 1, err: 1 }],
  ["ERR", <flow.Statistics>{ total: 1, err: 1 }],
  ["DEBUG", <flow.Statistics>{ total: 1, debug: 1 }],
  ["TRACE", <flow.Statistics>{ total: 1, debug: 1 }],
])(
  "Detect log %s level from message",
  (level: string, expected: flow.Statistics) => {
    test(`Uppercase ${level.toUpperCase()}`, () => {
      const context = tedge.createContext({});
      const output = flow.onMessage(
        {
          time: tedge.mockGetTime(),
          topic: "dummy",
          payload: JSON.stringify(<journald.JOURNALD_RAW_MESSAGE>{
            _SOURCE_REALTIME_TIMESTAMP: "123456",
            SYSLOG_TIMESTAMP: "", // Simulate log entry which does not have formal priority set by the application
            PRIORITY: "6", // default priority assigned by journald
            MESSAGE: `2025/07/02 15:55:32 ${level.toUpperCase()} Dummy log entry`,
          }),
        },
        context,
      );
      expect(output).toHaveLength(0);

      const currentState = flow.getState(context);
      expect(currentState.stats).toEqual({
        ...flow.createStatistics(),
        ...expected,
      });
    });

    test(`Lowercase ${level.toLowerCase()}`, () => {
      const context = tedge.createContext({});
      const output = flow.onMessage(
        {
          time: tedge.mockGetTime(),
          topic: "dummy",
          payload: JSON.stringify(<journald.JOURNALD_RAW_MESSAGE>{
            _SOURCE_REALTIME_TIMESTAMP: "123456",
            SYSLOG_TIMESTAMP: "", // Simulate log entry which does not have formal priority set by the application
            PRIORITY: "6", // default priority assigned by journald
            MESSAGE: `2025/07/02 15:55:32 ${level.toLocaleLowerCase()} Dummy log entry`,
          }),
        },
        context,
      );
      expect(output).toHaveLength(0);

      const currentState = flow.getState(context);
      expect(currentState.stats).toEqual({
        ...flow.createStatistics(),
        ...expected,
      });
    });
  },
);

test("Process mock data", () => {
  const config: flow.Config = {
    with_logs: false,
    debug: false,
    publish_statistics: true,
    stats_topic: "stats/logs",
    threshold: {
      info: 10,
      warning: 0,
      error: 0,
      total: 0,
    },
    text_filter: [],
  };
  const context = tedge.createContext(config);
  const messages: tedge.Message[] = journald
    .mockJournaldLogs(10)
    .map((value) => ({
      time: tedge.mockGetTime(),
      topic: "dummy",
      payload: JSON.stringify(value),
    }));
  const output = tedge.Run(flow, messages, context);
  expect(output.length).toBeGreaterThanOrEqual(1);
});

/*
    onInterval
*/
describe.each([
  [
    "Too many log messages",
    <flow.Config>{
      publish_statistics: false,
      threshold: { total: 1 },
    },
    <flow.Statistics>{ total: 1, warn: 1 },
    "Too many log messages detected",
    1,
  ],

  [
    "Too many error messages",
    <flow.Config>{
      publish_statistics: false,
      threshold: { error: 10 },
    },
    <flow.Statistics>{ total: 20, err: 11 },
    "Too many error messages detected",
    1,
  ],

  [
    "Too many warning messages",
    <flow.Config>{
      publish_statistics: false,
      threshold: { warning: 2 },
    },
    <flow.Statistics>{ total: 20, warn: 2 },
    "Too many warning messages detected",
    1,
  ],

  [
    "Too many info messages",
    <flow.Config>{
      publish_statistics: false,
      threshold: { info: 10202 },
    },
    <flow.Statistics>{ total: 20, info: 10202 },
    "Too many info messages detected",
    1,
  ],

  [
    "Too many messages (total >> info)",
    <flow.Config>{
      publish_statistics: false,
      threshold: { total: 200, info: 10 },
    },
    <flow.Statistics>{ total: 200, info: 15 },
    "Too many log messages detected",
    1,
  ],

  [
    "Too many error messages (error >> warn >> info)",
    <flow.Config>{
      publish_statistics: false,
      threshold: { total: 0, error: 1, warning: 1, info: 1 },
    },
    <flow.Statistics>{ err: 1, warn: 1, info: 1 },
    "Too many error messages detected",
    1,
  ],

  [
    "Too many warning messages (warn >> info)",
    <flow.Config>{
      publish_statistics: false,
      threshold: { total: 0, error: 1, warning: 1, info: 1 },
    },
    <flow.Statistics>{ err: 0, warn: 1, info: 1 },
    "Too many warning messages detected",
    1,
  ],
])(
  "text_filter can be used to filter log messages",
  (
    testCase: string,
    config: flow.Config,
    stats: flow.Statistics,
    expected: string,
    expectedLength: number,
  ) => {
    test(testCase, () => {
      const context = tedge.createContext(config);
      flow.setState(context, <flow.FlowState>{
        stats,
      });
      const output = flow.onInterval(tedge.mockGetTime(), context);
      expect(output).toHaveLength(expectedLength);
      const lastMessage = tedge.decodeJsonPayload(
        output[output.length - 1].payload,
      );
      expect(lastMessage).toHaveProperty("text");
      expect(lastMessage).toHaveProperty("severity");
      expect(lastMessage).toHaveProperty("time");
      expect(lastMessage["text"]).toEqual(expect.stringContaining(expected));
    });
  },
);

describe("log statistics", () => {
  test("publish log statistics", () => {
    const stats_topic = "stats/custom/output";
    const expectedTopic = `te/device/main///${stats_topic}`;
    const context = tedge.createContext(<flow.Config>{
      publish_statistics: true,
      stats_topic,
    });
    flow.setState(context, <flow.FlowState>{
      stats: <flow.Statistics>{
        info: 10,
        warn: 2,
        err: 1,
        total: 13,
      },
    });
    const output = flow.onInterval(tedge.mockGetTime(), context);
    expect(output.length).toBeGreaterThanOrEqual(1);
    expect(output[0].topic).toStrictEqual(expectedTopic);
    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload).toHaveProperty("total", 13);
    expect(payload).toHaveProperty("info", 10);
    expect(payload).toHaveProperty("warn", 2);
    expect(payload).toHaveProperty("err", 1);
  });

  test("skip publishing log statistics", () => {
    const stats_topic = "stats/custom/output";
    const context = tedge.createContext(<flow.Config>{
      publish_statistics: false,
      stats_topic,
    });
    // first run
    flow.setState(context, <flow.FlowState>{
      ran: false,
      stats: <flow.Statistics>{
        info: 10,
        warn: 2,
        err: 1,
        total: 13,
      },
    });
    const output1 = flow.onInterval(tedge.mockGetTime(), context);
    expect(output1).toHaveLength(0);

    // second run
    flow.setState(context, <flow.FlowState>{
      ran: true,
      stats: <flow.Statistics>{
        info: 10,
        warn: 2,
        err: 1,
        total: 13,
      },
    });
    const output2 = flow.onInterval(tedge.mockGetTime(), context);
    expect(output2).toHaveLength(1);
    expect(output2[0].payload).toBeFalsy();
    expect(output2[0].topic).toEqual(`te/device/main///a/log_surge`);
    expect(output2[0].mqtt?.retain).toStrictEqual(true);
  });
});
