import { expect, test, describe } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

const FLUSH_TIME = new Date("2024-06-01T12:00:00.000Z");

// ─── extractMeasurementKey ───────────────────────────────────────────────────

describe("extractMeasurementKey", () => {
  test("depth=1: returns the last segment as group, no series", () => {
    expect(flow.extractMeasurementKey("sensors/room1/temperature", 1)).toEqual({
      group: "temperature",
    });
  });

  test("depth=1: single-segment topic", () => {
    expect(flow.extractMeasurementKey("temperature", 1)).toEqual({
      group: "temperature",
    });
  });

  test("depth=2: second-to-last is group, last is series", () => {
    expect(flow.extractMeasurementKey("sensors/temperature/inside", 2)).toEqual(
      { group: "temperature", series: "inside" },
    );
  });

  test("depth=2: different series under the same group", () => {
    expect(
      flow.extractMeasurementKey("sensors/temperature/outside", 2),
    ).toEqual({ group: "temperature", series: "outside" });
  });

  test("depth=2: two-segment topic uses both segments", () => {
    expect(flow.extractMeasurementKey("temperature/inside", 2)).toEqual({
      group: "temperature",
      series: "inside",
    });
  });
});

// ─── parseNumericPayload ──────────────────────────────────────────────────────

describe("parseNumericPayload", () => {
  test("parses a plain integer string", () => {
    expect(flow.parseNumericPayload("42")).toBe(42);
  });

  test("parses a plain float string", () => {
    expect(flow.parseNumericPayload("23.5")).toBeCloseTo(23.5);
  });

  test("parses a JSON number", () => {
    expect(flow.parseNumericPayload("60")).toBe(60);
  });

  test("parses a JSON object with a value key", () => {
    expect(flow.parseNumericPayload('{"value": 1013.25}')).toBeCloseTo(1013.25);
  });

  test("returns undefined for a plain string", () => {
    expect(flow.parseNumericPayload("hello")).toBeUndefined();
  });

  test("returns undefined for a JSON string value", () => {
    expect(flow.parseNumericPayload('"hello"')).toBeUndefined();
  });

  test("returns undefined for an empty payload", () => {
    expect(flow.parseNumericPayload("")).toBeUndefined();
  });
});

// ─── onMessage ────────────────────────────────────────────────────────────────

describe("onMessage", () => {
  test("depth=1: stores a flat numeric value under the group name", () => {
    const context = tedge.createContext({ key_depth: 1 });
    const output = flow.onMessage(
      { time: new Date(), topic: "sensors/temperature", payload: "23.5" },
      context,
    );
    expect(output).toHaveLength(0);
    expect(context.flow.get("buffer")).toEqual({ temperature: 23.5 });
  });

  test("depth=1: buffers a JSON {value} payload as a flat number", () => {
    const context = tedge.createContext({ key_depth: 1 });
    flow.onMessage(
      { time: new Date(), topic: "sensors/humidity", payload: '{"value": 60}' },
      context,
    );
    expect(context.flow.get("buffer")).toEqual({ humidity: 60 });
  });

  test("depth=1: accumulates multiple flat datapoints", () => {
    const context = tedge.createContext({ key_depth: 1 });
    flow.onMessage(
      { time: new Date(), topic: "sensors/temperature", payload: "23.5" },
      context,
    );
    flow.onMessage(
      { time: new Date(), topic: "sensors/humidity", payload: "60" },
      context,
    );
    flow.onMessage(
      { time: new Date(), topic: "sensors/pressure", payload: "1013.25" },
      context,
    );
    expect(context.flow.get("buffer")).toEqual({
      temperature: 23.5,
      humidity: 60,
      pressure: 1013.25,
    });
  });

  test("depth=1: overwrites a flat value when the same topic arrives twice", () => {
    const context = tedge.createContext({ key_depth: 1 });
    flow.onMessage(
      { time: new Date(), topic: "sensors/temperature", payload: "20" },
      context,
    );
    flow.onMessage(
      { time: new Date(), topic: "sensors/temperature", payload: "25" },
      context,
    );
    expect(context.flow.get("buffer")).toEqual({ temperature: 25 });
  });

  test("depth=2: stores a nested series under the group name", () => {
    const context = tedge.createContext({ key_depth: 2 });
    flow.onMessage(
      { time: new Date(), topic: "sensors/temperature/inside", payload: "22" },
      context,
    );
    expect(context.flow.get("buffer")).toEqual({
      temperature: { inside: 22 },
    });
  });

  test("depth=2: merges multiple series arriving under the same group", () => {
    const context = tedge.createContext({ key_depth: 2 });
    flow.onMessage(
      {
        time: new Date(),
        topic: "sensors/temperature/inside",
        payload: "23.5",
      },
      context,
    );
    flow.onMessage(
      {
        time: new Date(),
        topic: "sensors/temperature/outside",
        payload: "30.1",
      },
      context,
    );
    expect(context.flow.get("buffer")).toEqual({
      temperature: { inside: 23.5, outside: 30.1 },
    });
  });

  test("depth=2: accumulates different groups independently", () => {
    const context = tedge.createContext({ key_depth: 2 });
    flow.onMessage(
      { time: new Date(), topic: "sensors/temperature/inside", payload: "22" },
      context,
    );
    flow.onMessage(
      { time: new Date(), topic: "sensors/humidity/room1", payload: "60" },
      context,
    );
    expect(context.flow.get("buffer")).toEqual({
      temperature: { inside: 22 },
      humidity: { room1: 60 },
    });
  });

  test("ignores non-numeric payloads and leaves buffer unchanged", () => {
    const context = tedge.createContext({});
    const output = flow.onMessage(
      { time: new Date(), topic: "sensors/status", payload: "online" },
      context,
    );
    expect(output).toHaveLength(0);
    expect(context.flow.get("buffer") ?? {}).toEqual({});
  });
});

// ─── onInterval ───────────────────────────────────────────────────────────────

describe("onInterval", () => {
  test("depth=1: emits flat values for all buffered groups", () => {
    const context = tedge.createContext({
      key_depth: 1,
      output_topic: "te/device/main///m/sensors",
    });
    flow.onMessage(
      { time: new Date(), topic: "sensors/temperature", payload: "23.5" },
      context,
    );
    flow.onMessage(
      { time: new Date(), topic: "sensors/humidity", payload: "60" },
      context,
    );

    const output = flow.onInterval(FLUSH_TIME, context);

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/device/main///m/sensors");

    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload.time).toBe("2024-06-01T12:00:00.000Z");
    expect(payload.temperature).toBe(23.5);
    expect(payload.humidity).toBe(60);
  });

  test("depth=2: emits nested series maps for each group", () => {
    const context = tedge.createContext({
      key_depth: 2,
      output_topic: "te/device/main///m/sensors",
    });
    flow.onMessage(
      {
        time: new Date(),
        topic: "sensors/temperature/inside",
        payload: "23.5",
      },
      context,
    );
    flow.onMessage(
      {
        time: new Date(),
        topic: "sensors/temperature/outside",
        payload: "30.1",
      },
      context,
    );
    flow.onMessage(
      { time: new Date(), topic: "sensors/humidity/room1", payload: "60" },
      context,
    );

    const output = flow.onInterval(FLUSH_TIME, context);

    expect(output).toHaveLength(1);
    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload.time).toBe("2024-06-01T12:00:00.000Z");
    expect(payload.temperature).toEqual({ inside: 23.5, outside: 30.1 });
    expect(payload.humidity).toEqual({ room1: 60 });
  });

  test("uses the default output topic when none configured", () => {
    const context = tedge.createContext({});
    flow.onMessage(
      { time: new Date(), topic: "sensors/temperature", payload: "21" },
      context,
    );
    const output = flow.onInterval(FLUSH_TIME, context);
    expect(output[0].topic).toBe("te/device/main///m/aggregated");
  });

  test("clears the buffer after emission", () => {
    const context = tedge.createContext({});
    flow.onMessage(
      { time: new Date(), topic: "sensors/temperature", payload: "21" },
      context,
    );
    flow.onInterval(FLUSH_TIME, context);

    // Second interval – buffer should be empty
    const second = flow.onInterval(FLUSH_TIME, context);
    expect(second).toHaveLength(0);
  });

  test("emits nothing when the buffer is empty", () => {
    const context = tedge.createContext({});
    const output = flow.onInterval(FLUSH_TIME, context);
    expect(output).toHaveLength(0);
  });

  test("measurement time matches the interval time", () => {
    const context = tedge.createContext({ key_depth: 1 });
    flow.onMessage(
      { time: new Date(), topic: "sensors/temperature", payload: "18" },
      context,
    );
    const output = flow.onInterval(FLUSH_TIME, context);
    expect(output[0].time).toEqual(FLUSH_TIME);
    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload.time).toBe(FLUSH_TIME.toISOString());
  });
});
