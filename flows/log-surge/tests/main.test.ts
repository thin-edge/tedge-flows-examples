import { expect, test, beforeEach, describe } from "@jest/globals";
import * as flow from "../src/main";
import * as journald from "../src/journald";
import * as tedge from "../../common/tedge";

beforeEach(() => {
  flow.get_state().stats.reset();
  flow.get_state().ran = false;
});

test("Config with_logs returns the log entries", async () => {
  const message: tedge.Message = {
    time: new Date(),
    topic: "dummy",
    payload: tedge.encodeJSON(<journald.JOURNALD_RAW_MESSAGE>{
      _SOURCE_REALTIME_TIMESTAMP: "1751468051367349",
      MESSAGE: "example",
    }),
  };
  const output1 = await flow.onMessage(message, {
    config: <flow.Config>{
      with_logs: true,
    },
  });
  expect(output1).toHaveLength(1);

  const output2 = await flow.onMessage(message, {
    config: <flow.Config>{
      with_logs: false,
    },
  });
  expect(output2).toHaveLength(0);
});

describe.each([
  ["Some important log message", [".*(important).*"], 1],
  ["Some log message", [".*(important).*"], 0],
  ["Some log message", [], 1],
])(
  "text_filter can be used to filter log messages",
  (text: string, text_filter: string[], expected: number) => {
    test("matches the expected count", async () => {
      const message: tedge.Message = {
        time: new Date(),
        topic: "dummy",
        payload: tedge.encodeJSON(<journald.JOURNALD_RAW_MESSAGE>{
          _SOURCE_REALTIME_TIMESTAMP: "1751468051367349",
          MESSAGE: text,
        }),
      };
      const output = await flow.onMessage(message, {
        config: <flow.Config>{
          text_filter,
          with_logs: true,
        },
      });
      expect(output).toHaveLength(expected);
    });
  },
);

test("Detect log entries with an unknown log level", async () => {
  const output = await flow.onMessage(
    {
      time: new Date(),
      topic: "",
      payload: tedge.encodeJSON({
        _SOURCE_REALTIME_TIMESTAMP: 123456,
        MESSAGE: "example",
      }),
    },
    { config: {} },
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
  test("Strips leading timestamp from mosquitto log messages", async () => {
    const output = await flow.onMessage(
      {
        time: new Date(),
        topic: "",
        payload: tedge.encodeJSON(<journald.JOURNALD_RAW_MESSAGE>{
          SYSLOG_IDENTIFIER: "mosquitto",
          _SOURCE_REALTIME_TIMESTAMP: "1751468051367349",
          MESSAGE: logMessage,
        }),
      },
      {
        config: <flow.Config>{
          with_logs: true,
        },
      },
    );
    expect(output).toHaveLength(1);
    const message = tedge.decodeJSON(output[0].payload);
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
    test(`Uppercase ${level.toUpperCase()}`, async () => {
      const output = await flow.onMessage(
        {
          time: new Date(),
          topic: "dummy",
          payload: tedge.encodeJSON(<journald.JOURNALD_RAW_MESSAGE>{
            _SOURCE_REALTIME_TIMESTAMP: "123456",
            SYSLOG_TIMESTAMP: "", // Simulate log entry which does not have formal priority set by the application
            PRIORITY: "6", // default priority assigned by journald
            MESSAGE: `2025/07/02 15:55:32 ${level.toUpperCase()} Dummy log entry`,
          }),
        },
        { config: {} },
      );
      expect(output).toHaveLength(0);

      const currentState = flow.get_state();
      expect(currentState.stats).toEqual(expected);
    });

    test(`Lowercase ${level.toLowerCase()}`, async () => {
      const output = await flow.onMessage(
        {
          time: new Date(),
          topic: "dummy",
          payload: tedge.encodeJSON(<journald.JOURNALD_RAW_MESSAGE>{
            _SOURCE_REALTIME_TIMESTAMP: "123456",
            SYSLOG_TIMESTAMP: "", // Simulate log entry which does not have formal priority set by the application
            PRIORITY: "6", // default priority assigned by journald
            MESSAGE: `2025/07/02 15:55:32 ${level.toLocaleLowerCase()} Dummy log entry`,
          }),
        },
        { config: {} },
      );
      expect(output).toHaveLength(0);

      const currentState = flow.get_state();
      expect(currentState.stats).toEqual(expected);
    });
  },
);

test("Process mock data", async () => {
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
  const messages: tedge.Message[] = journald
    .mockJournaldLogs(10)
    .map((value) => ({
      time: new Date(),
      topic: "dummy",
      payload: tedge.encodeJSON(value),
    }));
  const output = await tedge.Run(flow, messages, { config });
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
  "text_filter can be used to filter log messages",
  (
    testCase: string,
    config: flow.Config,
    stats: journald.Statistics,
    expected: string,
    expectedLength: number,
  ) => {
    test(testCase, async () => {
      flow.get_state().stats = stats;
      const output = await flow.onInterval(new Date(), { config });
      expect(output).toHaveLength(expectedLength);
      const lastMessage = tedge.decodeJSON(output[output.length - 1].payload);
      expect(lastMessage).toHaveProperty("text");
      expect(lastMessage).toHaveProperty("severity");
      expect(lastMessage).toHaveProperty("time");
      expect(lastMessage["text"]).toEqual(expect.stringContaining(expected));
    });
  },
);

describe("log statistics", () => {
  test("publish log statistics", async () => {
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
    const output = await flow.onInterval(new Date(), { config });
    expect(output.length).toBeGreaterThanOrEqual(1);
    expect(output[0].topic).toStrictEqual(expectedTopic);
    const payload = tedge.decodeJSON(output[0].payload);
    expect(payload).toHaveProperty("total", 13);
    expect(payload).toHaveProperty("info", 10);
    expect(payload).toHaveProperty("warn", 2);
    expect(payload).toHaveProperty("err", 1);
  });

  test("skip publishing log statistics", async () => {
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
    const output1 = await flow.onInterval(new Date(), { config });
    expect(output1).toHaveLength(0);

    // second run
    flow.get_state().stats = new journald.Statistics({
      info: 10,
      warn: 2,
      err: 1,
      total: 13,
    });
    const output2 = await flow.onInterval(new Date(), { config });
    expect(output2).toHaveLength(1);
    expect(tedge.decodeJSON(output2[0].payload)).toBeFalsy();
    expect(output2[0].topic).toEqual(`te/device/main///a/log_surge`);
    expect(output2[0].transportFields?.retain).toStrictEqual(true);
  });
});

describe("packaging", () => {
  test("version is valid semver", () => {
    expect(flow.version()).toMatch(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
    );
  });
});
