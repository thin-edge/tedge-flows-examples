import { expect, test, describe } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

const RECEIVE_TIME = new Date("2020-10-15T06:00:00.000Z");

describe("batched measurements", () => {
  test("splits a batch of two measurements into two messages", () => {
    const inputPayload = [
      { time: "2020-10-15T05:30:47+00:00", temperature: 25 },
      { time: "2020-10-15T05:30:48+00:00", temperature: 26 },
    ];
    const output = flow.onMessage(
      {
        time: RECEIVE_TIME,
        topic: "te/device/main///m/env",
        payload: JSON.stringify(inputPayload),
      },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(2);

    const p0 = tedge.decodeJsonPayload(output[0].payload);
    expect(output[0].topic).toBe("te/device/main///m/env");
    expect(p0).toMatchObject({
      temperature: 25,
      time: "2020-10-15T05:30:47+00:00",
    });

    const p1 = tedge.decodeJsonPayload(output[1].payload);
    expect(output[1].topic).toBe("te/device/main///m/env");
    expect(p1).toMatchObject({
      temperature: 26,
      time: "2020-10-15T05:30:48+00:00",
    });
  });

  test("fills in receive-time when item has no time field", () => {
    const inputPayload = [{ temperature: 25 }, { temperature: 26 }];
    const output = flow.onMessage(
      {
        time: RECEIVE_TIME,
        topic: "te/device/main///m/env",
        payload: JSON.stringify(inputPayload),
      },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(2);
    const p0 = tedge.decodeJsonPayload(output[0].payload);
    expect(p0.time).toBe(RECEIVE_TIME.toISOString());
    const p1 = tedge.decodeJsonPayload(output[1].payload);
    expect(p1.time).toBe(RECEIVE_TIME.toISOString());
  });

  test("item-level time overrides fallback time", () => {
    const itemTime = "2020-10-15T05:30:47+00:00";
    const output = flow.onMessage(
      {
        time: RECEIVE_TIME,
        topic: "te/device/main///m/env",
        payload: JSON.stringify([{ time: itemTime, temperature: 25 }]),
      },
      tedge.createContext({}),
    );

    const p = tedge.decodeJsonPayload(output[0].payload);
    expect(p.time).toBe(itemTime);
  });

  test("handles a batch with mixed time / no-time items", () => {
    const inputPayload = [
      { time: "2020-10-15T05:30:47+00:00", temperature: 25 },
      { temperature: 26 },
      {
        location: { latitude: 32.54, longitude: -117.67, altitude: 98.6 },
      },
    ];
    const output = flow.onMessage(
      {
        time: RECEIVE_TIME,
        topic: "te/device/main///m/location",
        payload: JSON.stringify(inputPayload),
      },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(3);

    const p0 = tedge.decodeJsonPayload(output[0].payload);
    expect(p0.time).toBe("2020-10-15T05:30:47+00:00");
    expect(p0.temperature).toBe(25);

    const p1 = tedge.decodeJsonPayload(output[1].payload);
    expect(p1.time).toBe(RECEIVE_TIME.toISOString());
    expect(p1.temperature).toBe(26);

    const p2 = tedge.decodeJsonPayload(output[2].payload);
    expect(p2.location).toEqual({
      latitude: 32.54,
      longitude: -117.67,
      altitude: 98.6,
    });
  });

  test("preserves the original topic for every output message", () => {
    const topic = "te/device/child001///m/sensor";
    const output = flow.onMessage(
      {
        time: RECEIVE_TIME,
        topic,
        payload: JSON.stringify([{ value: 1 }, { value: 2 }]),
      },
      tedge.createContext({}),
    );

    output.forEach((msg) => expect(msg.topic).toBe(topic));
  });
});

describe("single (non-batched) measurements", () => {
  test("returns no messages for a single-object payload (handled by built-in flow)", () => {
    const singlePayload = {
      time: "2020-10-15T05:30:47+00:00",
      temperature: 25,
    };
    const output = flow.onMessage(
      {
        time: RECEIVE_TIME,
        topic: "te/device/main///m/env",
        payload: JSON.stringify(singlePayload),
      },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(0);
  });
});

describe("empty batch", () => {
  test("returns no messages for an empty array", () => {
    const output = flow.onMessage(
      {
        time: RECEIVE_TIME,
        topic: "te/device/main///m/env",
        payload: JSON.stringify([]),
      },
      tedge.createContext({}),
    );
    expect(output).toHaveLength(0);
  });
});
