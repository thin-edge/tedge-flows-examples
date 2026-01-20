import { expect, test, describe, beforeEach } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

jest.useFakeTimers();

test("Converts string to a timestamp", () => {
  const output = flow.onMessage(
    {
      time: tedge.mockGetTime(),
      topic: "example",
      payload: "1",
    },
    tedge.createContext(),
  );
  expect(output).toHaveLength(0);
});

describe("process", () => {
  beforeEach(() => {
    // Reset the internal state of the UptimeTracker in main.ts
    // This is a bit hacky, ideally UptimeTracker would be injected or resettable
    // For testing purposes, we can re-initialize it if it's a global instance
    jest.resetModules();
  });

  describe("process", () => {
    const now = new Date("2025-01-01T12:00:00Z");
    let flow: typeof import("../src/main");

    beforeEach(() => {
      jest.resetModules();
      flow = require("../src/main");
    });

    test('should update status to online when payload is "1"', () => {
      const time = now;
      const message = { time, topic: "test", payload: "1" };
      flow.onMessage(message, tedge.createContext());
      const output = flow.onInterval(
        time,
        tedge.createContext({ window_size_minutes: 600 }),
      );
      const twinMessage = output.find((msg) =>
        msg.topic.includes("twin/onlineTracker"),
      );
      expect(twinMessage).toBeDefined();
      if (twinMessage) {
        const payload = JSON.parse(twinMessage.payload);
        expect(payload.online).toBeCloseTo(100, 1);
        expect(payload).toHaveProperty("currentStatus", "online");
      }
    });
  });

  test('should update status to offline when payload is "0"', () => {
    const time = new Date();
    const message = { time, topic: "test", payload: "0" };
    flow.onMessage(message, tedge.createContext());
    const output = flow.onInterval(time, {
      config: { window_size_minutes: 600 },
    });
    const twinMessage = output.find((msg) =>
      msg.topic.includes("twin/onlineTracker"),
    );
    expect(twinMessage).toBeDefined();
    if (twinMessage) {
      const payload = JSON.parse(twinMessage.payload);
      expect(payload.offline).toBeCloseTo(100, 1);
      expect(payload).toHaveProperty("currentStatus", "offline");
    }
  });
});

describe("UptimeTracker advanced features", () => {
  const { UptimeTracker } = require("../src/uptime");

  test("should not be indeterminate by default", () => {
    const tracker = new UptimeTracker(10);
    expect(tracker.isUninitialized()).toBe(true); // No history, so indeterminate
  });

  test("should be indeterminate when reset to 'uninitialized'", () => {
    const tracker = new UptimeTracker(10);
    tracker.reset(10, "uninitialized");
    expect(tracker.isUninitialized()).toBe(true);
  });

  test("should not be indeterminate after setting to online", () => {
    const tracker = new UptimeTracker(10);
    tracker.reset(10, "online");
    expect(tracker.isUninitialized()).toBe(false);
  });

  test("should be indeterminate if history is empty", () => {
    const tracker = new UptimeTracker(10);
    tracker["history"] = [];
    expect(tracker.isUninitialized()).toBe(true);
  });

  test("reset should update window size and initial state", () => {
    const tracker = new UptimeTracker(1);
    tracker.reset(5, "offline", 1234567890);
    expect(tracker["windowSizeMs"]).toBe(5 * 60 * 1000);
    expect(tracker["history"][0]).toEqual({
      status: "offline",
      timestamp: 1234567890,
    });
  });
});

describe("UptimeTracker process payload variants", () => {
  let flow: typeof import("../src/main");
  const now = new Date("2025-01-01T12:00:00Z").getTime();
  beforeEach(() => {
    jest.resetModules();
    flow = require("../src/main");
  });

  test('payload "1" sets status to online', () => {
    const time = new Date(now);
    const message = { time, topic: "test", payload: "1" };
    flow.onMessage(message, tedge.createContext());
    const output = flow.onInterval(time, tedge.createContext());
    const twinMessage = output.find((msg) =>
      msg.topic.includes("twin/onlineTracker"),
    );
    expect(twinMessage).toBeDefined();
    if (twinMessage) {
      const payload = JSON.parse(twinMessage.payload);
      expect(payload.online).toBeCloseTo(100, 1);
    }
  });

  test('payload "0" sets status to offline', () => {
    const time = new Date(now);
    const message = { time, topic: "test", payload: "0" };
    flow.onMessage(message, tedge.createContext());
    const output = flow.onInterval(time, tedge.createContext());
    const twinMessage = output.find((msg) =>
      msg.topic.includes("twin/onlineTracker"),
    );
    expect(twinMessage).toBeDefined();
    if (twinMessage) {
      const payload = JSON.parse(twinMessage.payload);
      expect(payload.offline).toBeCloseTo(100, 1);
    }
  });

  test('payload {"status": "up"} sets status to online', () => {
    const time = new Date(now);
    const message = {
      time,
      topic: "test",
      payload: JSON.stringify({ status: "up" }),
    };
    flow.onMessage(message, tedge.createContext());
    const output = flow.onInterval(time, tedge.createContext());
    const twinMessage = output.find((msg) =>
      msg.topic.includes("twin/onlineTracker"),
    );
    expect(twinMessage).toBeDefined();
    if (twinMessage) {
      const payload = JSON.parse(twinMessage.payload);
      expect(payload.online).toBeCloseTo(100, 1);
    }
  });

  test('payload {"status": "down"} sets status to offline', () => {
    const time = new Date(now);
    const message = {
      time,
      topic: "test",
      payload: JSON.stringify({ status: "down" }),
    };
    flow.onMessage(message, tedge.createContext());
    const output = flow.onInterval(time, tedge.createContext());
    const twinMessage = output.find((msg) =>
      msg.topic.includes("twin/onlineTracker"),
    );
    expect(twinMessage).toBeDefined();
    if (twinMessage) {
      const payload = JSON.parse(twinMessage.payload);
      expect(payload.offline).toBeCloseTo(100, 1);
    }
  });

  test('payload {"status": "unknown"} does not throw and sets status', () => {
    const time = new Date(now);
    const message = {
      time,
      topic: "test",
      payload: JSON.stringify({ status: "unknown" }),
    };
    expect(() => flow.onMessage(message, tedge.createContext())).not.toThrow();
    const output = flow.onInterval(time, tedge.createContext());
    const twinMessage = output.find((msg) =>
      msg.topic.includes("twin/onlineTracker"),
    );
    expect(twinMessage).toBeDefined();
  });
});

describe("UptimeTracker duration reporting", () => {
  const { UptimeTracker } = require("../src/uptime");
  const minute = 60;
  const now = new Date("2025-01-01T12:00:00Z").getTime();

  beforeEach(() => {
    jest.setSystemTime(now); // Ensure system time is set for each test
  });

  test("duration is 0 when no history", () => {
    const tracker = new UptimeTracker(10);
    const { durationMs } = tracker.getUptimePercentage();
    expect(durationMs).toBe(0);
  });

  test("duration is correct for single event", () => {
    const tracker = new UptimeTracker(10);
    tracker.updateStatus("online", now - 5 * minute * 1000);
    const { durationMs } = tracker.getUptimePercentage();
    // Should be 5 minutes (from event to now)
    expect(Math.round(durationMs / 1000)).toBe(5 * minute);
  });

  test("duration is correct for multiple events", () => {
    const tracker = new UptimeTracker(10);
    tracker.updateStatus("online", now - 8 * minute * 1000);
    tracker.updateStatus("offline", now - 3 * minute * 1000);
    const { durationMs, interruptions } = tracker.getUptimePercentage();
    expect(Math.round(durationMs / 1000)).toBe(8 * minute);
    expect(interruptions).toBe(1);
  });

  test("duration is correct when events outside window are ignored", () => {
    const tracker = new UptimeTracker(5);
    tracker.updateStatus("online", now - 10 * minute * 1000);
    tracker.updateStatus("offline", now - 2 * minute * 1000);
    const { durationMs } = tracker.getUptimePercentage();
    // Should be 5 minutes (window size, synthetic event at window start)
    expect(Math.round(durationMs / 1000)).toBe(5 * minute);
  });

  test("percentage is calculated over observed duration if less than window size", () => {
    const tracker = new UptimeTracker(10); // 10 min window
    // Only 2 minutes of history
    tracker.updateStatus("online", now - 2 * minute * 1000);
    const { percentage, durationMs } = tracker.getUptimePercentage();
    // Should be 100% online over 2 minutes (observed duration)
    expect(Math.round(durationMs / 1000)).toBe(2 * minute);
    expect(percentage).toBeCloseTo(100, 1);
  });

  test("percentage is calculated over observed duration for partial online", () => {
    const tracker = new UptimeTracker(10); // 10 min window
    // 2 minutes online, 1 minute offline
    tracker.updateStatus("online", now - 3 * minute * 1000);
    tracker.updateStatus("offline", now - 1 * minute * 1000);
    const { percentage, durationMs, interruptions } =
      tracker.getUptimePercentage();
    // 2 min online, 1 min offline, duration = 3 min (observed duration)
    expect(Math.round(durationMs / 1000)).toBe(3 * minute);
    expect(percentage).toBeCloseTo((2 / 3) * 100, 1);
    expect(interruptions).toBe(1);
  });
});
