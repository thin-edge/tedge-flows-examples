import { expect, test, beforeEach, describe } from "@jest/globals";
import * as flow from "../src/main";
import * as journald from "../src/journald";
import * as tedge from "../../common/tedge";

beforeEach(() => {
  flow.get_state().stats.reset();
  flow.get_state().ran = false;
});

test("Config withLogs returns the log entries", () => {
  const message: tedge.Message = {
    topic: "dummy",
    payload: JSON.stringify(<journald.JOURNALD_RAW_MESSAGE>{
      _SOURCE_REALTIME_TIMESTAMP: "1751468051367349",
      MESSAGE: "example",
    }),
  };
  const output1 = flow.process(tedge.mockGetTime(), message, <flow.Config>{
    withLogs: true,
  });
  expect(output1).toHaveLength(1);

  const output2 = flow.process(tedge.mockGetTime(), message, <flow.Config>{
    withLogs: false,
  });
  expect(output2).toHaveLength(0);
});

describe.each([
  ["Some important log message", [".*(important).*"], 1],
  ["Some log message", [".*(important).*"], 0],
  ["Some log message", [], 1],
])(
  "textFilter can be used to filter log messages",
  (text: string, textFilter: string[], expected: number) => {
    test("matches the expected count", () => {
      const message: tedge.Message = {
        topic: "dummy",
        payload: JSON.stringify(<journald.JOURNALD_RAW_MESSAGE>{
          _SOURCE_REALTIME_TIMESTAMP: "1751468051367349",
          MESSAGE: text,
        }),
      };
      const output = flow.process(tedge.mockGetTime(), message, <flow.Config>{
        textFilter,
        withLogs: true,
      });
      expect(output).toHaveLength(expected);
    });
  },
);

test("Detect log entries with an unknown log level", () => {
  const output = flow.process(
    { seconds: 1, nanoseconds: 1234 },
    {
      topic: "",
      payload: JSON.stringify({
        _SOURCE_REALTIME_TIMESTAMP: 123456,
        MESSAGE: "example",
      }),
    },
    <flow.Config>{},
  );
  expect(output).toHaveLength(0);

  const currentState = flow.get_state();
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
    const output = flow.process(
      { seconds: 1, nanoseconds: 1234 },
      {
        topic: "",
        payload: JSON.stringify(<journald.JOURNALD_RAW_MESSAGE>{
          SYSLOG_IDENTIFIER: "mosquitto",
          _SOURCE_REALTIME_TIMESTAMP: "1751468051367349",
          MESSAGE: logMessage,
        }),
      },
      <flow.Config>{
        withLogs: true,
      },
    );
    expect(output).toHaveLength(1);
    const message = JSON.parse(output[0].payload);
    expect(message).toHaveProperty("text", expected);
    expect(message).toHaveProperty("time", 1751468051.367349);
  });
});

describe.each([
  ["WARN", new journald.Statistics({ total: 1, warn: 1 })],
  ["WARNING", new journald.Statistics({ total: 1, warn: 1 })],
  ["INFO", new journald.Statistics({ total: 1, info: 1 })],
  ["ERROR", new journald.Statistics({ total: 1, err: 1 })],
  ["ERR", new journald.Statistics({ total: 1, err: 1 })],
  ["DEBUG", new journald.Statistics({ total: 1, debug: 1 })],
  ["TRACE", new journald.Statistics({ total: 1, debug: 1 })],
])(
  "Detect log %s level from message",
  (level: string, expected: journald.Statistics) => {
    test(`Uppercase ${level.toUpperCase()}`, () => {
      const output = flow.process(
        tedge.mockGetTime(),
        {
          topic: "dummy",
          payload: JSON.stringify(<journald.JOURNALD_RAW_MESSAGE>{
            _SOURCE_REALTIME_TIMESTAMP: "123456",
            SYSLOG_TIMESTAMP: "", // Simulate log entry which does not have formal priority set by the application
            PRIORITY: "6", // default priority assigned by journald
            MESSAGE: `2025/07/02 15:55:32 ${level.toUpperCase()} Dummy log entry`,
          }),
        },
        <flow.Config>{},
      );
      expect(output).toHaveLength(0);

      const currentState = flow.get_state();
      expect(currentState.stats).toEqual(expected);
    });

    test(`Lowercase ${level.toLowerCase()}`, () => {
      const output = flow.process(
        tedge.mockGetTime(),
        {
          topic: "dummy",
          payload: JSON.stringify(<journald.JOURNALD_RAW_MESSAGE>{
            _SOURCE_REALTIME_TIMESTAMP: "123456",
            SYSLOG_TIMESTAMP: "", // Simulate log entry which does not have formal priority set by the application
            PRIORITY: "6", // default priority assigned by journald
            MESSAGE: `2025/07/02 15:55:32 ${level.toLocaleLowerCase()} Dummy log entry`,
          }),
        },
        {},
      );
      expect(output).toHaveLength(0);

      const currentState = flow.get_state();
      expect(currentState.stats).toEqual(expected);
    });
  },
);

test("Process mock data", () => {
  const config: flow.Config = {
    withLogs: false,
    debug: false,
    publish_statistics: true,
    stats_topic: "stats/logs",
    threshold: {
      info: 10,
      warning: 0,
      error: 0,
      total: 0,
    },
    textFilter: [],
  };
  const messages: tedge.Message[] = journald
    .mockJournaldLogs(10)
    .map((value) => ({
      topic: "dummy",
      payload: JSON.stringify(value),
    }));
  const output = tedge.Run(flow, messages, config);
  expect(output.length).toBeGreaterThanOrEqual(1);
});

/*
    Tick
*/
describe.each([
  [
    "Too many log messages",
    <flow.Config>{
      publish_statistics: false,
      threshold: { total: 1 },
    },
    new journald.Statistics({ total: 1, warn: 1 }),
    "Too many log messages detected",
    1,
  ],

  [
    "Too many error messages",
    <flow.Config>{
      publish_statistics: false,
      threshold: { error: 10 },
    },
    new journald.Statistics({ total: 20, err: 11 }),
    "Too many error messages detected",
    1,
  ],

  [
    "Too many warning messages",
    <flow.Config>{
      publish_statistics: false,
      threshold: { warning: 2 },
    },
    new journald.Statistics({ total: 20, warn: 2 }),
    "Too many warning messages detected",
    1,
  ],

  [
    "Too many info messages",
    <flow.Config>{
      publish_statistics: false,
      threshold: { info: 10202 },
    },
    new journald.Statistics({ total: 20, info: 10202 }),
    "Too many info messages detected",
    1,
  ],

  [
    "Too many messages (total >> info)",
    <flow.Config>{
      publish_statistics: false,
      threshold: { total: 200, info: 10 },
    },
    new journald.Statistics({ total: 200, info: 15 }),
    "Too many log messages detected",
    1,
  ],

  [
    "Too many error messages (error >> warn >> info)",
    <flow.Config>{
      publish_statistics: false,
      threshold: { total: 0, error: 1, warning: 1, info: 1 },
    },
    new journald.Statistics({ err: 1, warn: 1, info: 1 }),
    "Too many error messages detected",
    1,
  ],

  [
    "Too many warning messages (warn >> info)",
    <flow.Config>{
      publish_statistics: false,
      threshold: { total: 0, error: 1, warning: 1, info: 1 },
    },
    new journald.Statistics({ err: 0, warn: 1, info: 1 }),
    "Too many warning messages detected",
    1,
  ],
])(
  "textFilter can be used to filter log messages",
  (
    testCase: string,
    config: flow.Config,
    stats: journald.Statistics,
    expected: string,
    expectedLength: number,
  ) => {
    test(testCase, () => {
      flow.get_state().stats = stats;
      const output = flow.tick(tedge.mockGetTime(), config);
      expect(output).toHaveLength(expectedLength);
      const lastMessage = JSON.parse(output[output.length - 1].payload);
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
    const config: flow.Config = {
      publish_statistics: true,
      stats_topic,
    };
    flow.get_state().stats = new journald.Statistics({
      info: 10,
      warn: 2,
      err: 1,
      total: 13,
    });
    const output = flow.tick(tedge.mockGetTime(), config);
    expect(output.length).toBeGreaterThanOrEqual(1);
    expect(output[0].topic).toStrictEqual(expectedTopic);
    const payload = JSON.parse(output[0].payload);
    expect(payload).toHaveProperty("total", 13);
    expect(payload).toHaveProperty("info", 10);
    expect(payload).toHaveProperty("warn", 2);
    expect(payload).toHaveProperty("err", 1);
  });

  test("skip publishing log statistics", () => {
    const stats_topic = "stats/custom/output";
    const config: flow.Config = {
      publish_statistics: false,
      stats_topic,
    };
    // first run
    flow.get_state().ran = false;
    flow.get_state().stats = new journald.Statistics({
      info: 10,
      warn: 2,
      err: 1,
      total: 13,
    });
    const output1 = flow.tick(tedge.mockGetTime(), config);
    expect(output1).toHaveLength(0);

    // second run
    flow.get_state().stats = new journald.Statistics({
      info: 10,
      warn: 2,
      err: 1,
      total: 13,
    });
    const output2 = flow.tick(tedge.mockGetTime(), config);
    expect(output2).toHaveLength(1);
    expect(output2[0].payload).toBeFalsy();
    expect(output2[0].topic).toEqual(`te/device/main///a/log_surge`);
    expect(output2[0].retain).toStrictEqual(true);
  });
});

describe("packaging", () => {
  test("version is valid semver", () => {
    expect(flow.version()).toMatch(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
    );
  });
});
