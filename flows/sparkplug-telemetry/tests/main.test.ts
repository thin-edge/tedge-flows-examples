import { expect, test, describe } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";
import { create, toBinary } from "@bufbuild/protobuf";
import { PayloadSchema, Payload_MetricSchema } from "../src/gen/sparkplug_b_pb";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a binary Sparkplug B payload where every metric has a name (BIRTH
 * style, or DATA with disableAliases=true).
 */
function makePayload(
  metrics: { name: string; value: number | boolean | string; alias?: number }[],
  timestampMs?: number,
): Uint8Array {
  return toBinary(
    PayloadSchema,
    create(PayloadSchema, {
      timestamp: timestampMs !== undefined ? BigInt(timestampMs) : BigInt(0),
      metrics: metrics.map(({ name, value, alias }) => {
        let v: ReturnType<typeof create<typeof Payload_MetricSchema>>["value"];
        if (typeof value === "number" && Number.isInteger(value)) {
          v = { case: "intValue" as const, value };
        } else if (typeof value === "number") {
          v = { case: "doubleValue" as const, value };
        } else if (typeof value === "boolean") {
          v = { case: "booleanValue" as const, value };
        } else {
          v = { case: "stringValue" as const, value };
        }
        return create(Payload_MetricSchema, {
          name,
          ...(alias !== undefined ? { alias: BigInt(alias) } : {}),
          value: v,
        });
      }),
    }),
  );
}

/**
 * Build a DATA-style binary payload where metrics are identified by alias
 * only (no name field).  Mirrors what sparkplug-publisher emits for DDATA.
 */
function makeAliasPayload(
  metrics: { alias: number; value: number | boolean | string }[],
  timestampMs?: number,
): Uint8Array {
  return toBinary(
    PayloadSchema,
    create(PayloadSchema, {
      timestamp: timestampMs !== undefined ? BigInt(timestampMs) : BigInt(0),
      metrics: metrics.map(({ alias, value }) => {
        let v: ReturnType<typeof create<typeof Payload_MetricSchema>>["value"];
        if (typeof value === "number") {
          v = { case: "doubleValue" as const, value };
        } else if (typeof value === "boolean") {
          v = { case: "booleanValue" as const, value };
        } else {
          v = { case: "stringValue" as const, value };
        }
        return create(Payload_MetricSchema, { alias: BigInt(alias), value: v });
      }),
    }),
  );
}

// ── Measurements ──────────────────────────────────────────────────────────────

describe("sparkplug-telemetry — measurements", () => {
  test("DDATA: maps metrics to thin-edge.io device measurement", () => {
    const timestamp = new Date("2026-02-25T10:00:00.000Z");
    const payload = makePayload(
      [
        { name: "temperature", value: 23.5 },
        { name: "humidity", value: 60.0 },
      ],
      timestamp.getTime(),
    );

    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/myGroup/DDATA/myNode/myDevice",
        payload,
      },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/device/myDevice///m/");
    const body = JSON.parse(output[0].payload as string);
    expect(body.time).toBe("2026-02-25T10:00:00.000Z");
    expect(body.temperature).toBeCloseTo(23.5);
    expect(body.humidity).toBeCloseTo(60.0);
  });

  test("NDATA: maps metrics to thin-edge.io edge node measurement", () => {
    const payload = makePayload([{ name: "uptime", value: 12345 }]);

    const output = flow.onMessage(
      {
        time: new Date("2026-02-25T10:00:00.000Z"),
        topic: "spBv1.0/myGroup/NDATA/myNode",
        payload,
      },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/device/myNode///m/");
    const body = JSON.parse(output[0].payload as string);
    expect(body.uptime).toBe(12345);
  });

  test("DBIRTH: birth certificate metrics are NOT forwarded as measurements (BIRTH is a state snapshot, not an exception)", () => {
    const payload = makePayload([{ name: "voltage", value: 230.1 }]);

    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/factory/DBIRTH/gateway/sensor01",
        payload,
      },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(0);
  });

  test("boolean metric is emitted as an event, not a measurement", () => {
    const payload = makePayload([{ name: "active", value: true }]);

    const output = flow.onMessage(
      { time: new Date(), topic: "spBv1.0/g/DDATA/n/d", payload },
      tedge.createContext({}),
    );

    // Boolean metrics become events (with RbE), not measurements.
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/device/d///e/active");
    expect(output.some((m) => m.topic.includes("///m/"))).toBe(false);
  });

  test("string-valued metrics are excluded from measurements", () => {
    // String values go through the Event/Alarm paths — plain metric strings
    // have no home in a thin-edge.io measurement, so they must be dropped.
    const payload = makePayload([
      { name: "temperature", value: 42.0 },
      { name: "status", value: "ok" },
    ]);

    const output = flow.onMessage(
      { time: new Date(), topic: "spBv1.0/g/DDATA/n/d", payload },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(1);
    const body = JSON.parse(output[0].payload as string);
    expect(body.temperature).toBeCloseTo(42.0);
    expect(body.status).toBeUndefined();
  });

  test("payload timestamp takes precedence over message receive time", () => {
    const payloadTs = new Date("2026-01-15T08:30:00.000Z");
    const messageTs = new Date("2026-01-15T09:00:00.000Z");
    const payload = makePayload(
      [{ name: "temp", value: 20.0 }],
      payloadTs.getTime(),
    );

    const output = flow.onMessage(
      { time: messageTs, topic: "spBv1.0/g/DDATA/n/d", payload },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(1);
    const body = JSON.parse(output[0].payload as string);
    expect(body.time).toBe("2026-01-15T08:30:00.000Z");
  });
});

// ── Alias resolution ──────────────────────────────────────────────────────────

describe("sparkplug-telemetry — alias resolution", () => {
  test("BIRTH builds alias registry; subsequent DDATA using aliases is decoded", () => {
    const ctx = tedge.createContext({});
    const birthTs = new Date("2026-02-25T10:00:00.000Z");

    // BIRTH: temperature → alias 0, humidity → alias 1
    flow.onMessage(
      {
        time: birthTs,
        topic: "spBv1.0/g/DBIRTH/n/d",
        payload: makePayload(
          [
            { name: "temperature", value: 23.5, alias: 0 },
            { name: "humidity", value: 60.0, alias: 1 },
          ],
          birthTs.getTime(),
        ),
      },
      ctx,
    );

    // DATA: metrics identified by alias only (no name on the wire)
    const dataTs = new Date("2026-02-25T10:01:00.000Z");
    const output = flow.onMessage(
      {
        time: dataTs,
        topic: "spBv1.0/g/DDATA/n/d",
        payload: makeAliasPayload(
          [
            { alias: 0, value: 24.0 },
            { alias: 1, value: 61.0 },
          ],
          dataTs.getTime(),
        ),
      },
      ctx,
    );

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/device/d///m/");
    const body = JSON.parse(output[0].payload as string);
    expect(body.temperature).toBeCloseTo(24.0);
    expect(body.humidity).toBeCloseTo(61.0);
  });

  test("NBIRTH builds alias registry for edge node; NDATA uses aliases", () => {
    const ctx = tedge.createContext({});
    const ts = new Date("2026-02-25T10:00:00.000Z");

    flow.onMessage(
      {
        time: ts,
        topic: "spBv1.0/g/NBIRTH/myNode",
        payload: makePayload(
          [{ name: "cpu", value: 12.5, alias: 0 }],
          ts.getTime(),
        ),
      },
      ctx,
    );

    const output = flow.onMessage(
      {
        time: ts,
        topic: "spBv1.0/g/NDATA/myNode",
        payload: makeAliasPayload([{ alias: 0, value: 15.0 }], ts.getTime()),
      },
      ctx,
    );

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/device/myNode///m/");
    const body = JSON.parse(output[0].payload as string);
    expect(body.cpu).toBeCloseTo(15.0);
  });

  test("alias registries are isolated per device", () => {
    const ctx = tedge.createContext({});
    const ts = new Date("2026-02-25T10:00:00.000Z");

    // Device A: alias 0 = "temperature"
    flow.onMessage(
      {
        time: ts,
        topic: "spBv1.0/g/DBIRTH/n/deviceA",
        payload: makePayload(
          [{ name: "temperature", value: 20.0, alias: 0 }],
          ts.getTime(),
        ),
      },
      ctx,
    );

    // Device B: alias 0 = "pressure"
    flow.onMessage(
      {
        time: ts,
        topic: "spBv1.0/g/DBIRTH/n/deviceB",
        payload: makePayload(
          [{ name: "pressure", value: 1013.0, alias: 0 }],
          ts.getTime(),
        ),
      },
      ctx,
    );

    const outA = flow.onMessage(
      {
        time: ts,
        topic: "spBv1.0/g/DDATA/n/deviceA",
        payload: makeAliasPayload([{ alias: 0, value: 21.0 }], ts.getTime()),
      },
      ctx,
    );

    const outB = flow.onMessage(
      {
        time: ts,
        topic: "spBv1.0/g/DDATA/n/deviceB",
        payload: makeAliasPayload([{ alias: 0, value: 1015.0 }], ts.getTime()),
      },
      ctx,
    );

    expect(JSON.parse(outA[0].payload as string).temperature).toBeCloseTo(21.0);
    expect(JSON.parse(outB[0].payload as string).pressure).toBeCloseTo(1015.0);
  });

  test("DATA with alias-only metrics and no prior BIRTH requests rebirth via NCMD", () => {
    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/g/DDATA/n/myNode",
        payload: makeAliasPayload([{ alias: 99, value: 10.0 }]),
      },
      tedge.createContext({}),
    );

    // Per Sparkplug B spec, the PA must request a rebirth when it receives
    // DATA without a corresponding BIRTH (empty alias registry).
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("spBv1.0/g/NCMD/n");
    expect(output[0].payload).toBeInstanceOf(Uint8Array);
    expect(output[0].mqtt?.qos).toBe(1);
  });

  test("rebirth is only requested once per edge node (not on every DATA)", () => {
    const ctx = tedge.createContext({});

    // First DATA without BIRTH → triggers rebirth
    const first = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/g/DDATA/n/myNode",
        payload: makeAliasPayload([{ alias: 1, value: 10.0 }]),
      },
      ctx,
    );
    expect(first).toHaveLength(1);
    expect(first[0].topic).toBe("spBv1.0/g/NCMD/n");

    // Second DATA without BIRTH → no duplicate rebirth
    const second = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/g/DDATA/n/myNode",
        payload: makeAliasPayload([{ alias: 1, value: 11.0 }]),
      },
      ctx,
    );
    expect(second).toHaveLength(0);
  });
});

// ── Events ────────────────────────────────────────────────────────────────────

describe("sparkplug-telemetry — events", () => {
  test("Event/{type} String metric maps to te event topic", () => {
    const ts = new Date("2026-02-25T10:00:00.000Z");
    const payload = makePayload(
      [{ name: "Event/login", value: "user admin logged in" }],
      ts.getTime(),
    );

    const output = flow.onMessage(
      { time: ts, topic: "spBv1.0/g/DDATA/n/d", payload },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/device/d///e/login");
    const body = JSON.parse(output[0].payload as string);
    expect(body.text).toBe("user admin logged in");
    expect(body.time).toBe(ts.toISOString());
  });

  test("Event metric in BIRTH certificate is NOT forwarded as an event (BIRTH is a state snapshot, not an exception)", () => {
    const ts = new Date("2026-02-25T10:00:00.000Z");
    const output = flow.onMessage(
      {
        time: ts,
        topic: "spBv1.0/g/DBIRTH/n/sensor01",
        payload: makePayload(
          [{ name: "Event/boot", value: "device booted" }],
          ts.getTime(),
        ),
      },
      tedge.createContext({}),
    );

    // BIRTH carries a full state snapshot for alias registration.
    // Re-emitting events on every reconnect would flood thin-edge.io with stale history.
    expect(output).toHaveLength(0);
  });

  test("alias-resolved Event metric from DDATA is mapped to event topic", () => {
    const ctx = tedge.createContext({});
    const ts = new Date("2026-02-25T10:00:00.000Z");

    // BIRTH: Event/alert → alias 0
    flow.onMessage(
      {
        time: ts,
        topic: "spBv1.0/g/DBIRTH/n/d",
        payload: makePayload(
          [{ name: "Event/alert", value: "first alert", alias: 0 }],
          ts.getTime(),
        ),
      },
      ctx,
    );

    // DATA: alias 0 with new text
    const output = flow.onMessage(
      {
        time: ts,
        topic: "spBv1.0/g/DDATA/n/d",
        payload: makeAliasPayload(
          [{ alias: 0, value: "second alert" }],
          ts.getTime(),
        ),
      },
      ctx,
    );

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/device/d///e/alert");
    expect(JSON.parse(output[0].payload as string).text).toBe("second alert");
  });

  test("Event metric on edge node uses NBIRTH/NDATA topic correctly", () => {
    const ts = new Date("2026-02-25T10:00:00.000Z");
    const output = flow.onMessage(
      {
        time: ts,
        topic: "spBv1.0/g/NDATA/myNode",
        payload: makePayload(
          [{ name: "Event/reboot", value: "gateway rebooted" }],
          ts.getTime(),
        ),
      },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/device/myNode///e/reboot");
  });

  test("payload with both measurement and event metrics produces two output messages", () => {
    const ts = new Date("2026-02-25T10:00:00.000Z");
    const payload = makePayload(
      [
        { name: "temperature", value: 55.0 },
        { name: "Event/overheat", value: "temp exceeded threshold" },
      ],
      ts.getTime(),
    );

    const output = flow.onMessage(
      { time: ts, topic: "spBv1.0/g/DDATA/n/d", payload },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(2);
    const measMsg = output.find((m) => m.topic.includes("///m/"))!;
    const eventMsg = output.find((m) => m.topic.includes("///e/"))!;
    expect(JSON.parse(measMsg.payload as string).temperature).toBeCloseTo(55.0);
    expect(eventMsg.topic).toBe("te/device/d///e/overheat");
    expect(JSON.parse(eventMsg.payload as string).text).toBe(
      "temp exceeded threshold",
    );
  });
});

// ── Boolean events ────────────────────────────────────────────────────────────

describe("sparkplug-telemetry — boolean events", () => {
  test("boolean metric in DDATA emits an event on first receipt", () => {
    const ts = new Date("2026-02-25T10:00:00.000Z");
    const payload = makePayload([{ name: "door.open", value: false }], ts.getTime());

    const output = flow.onMessage(
      { time: ts, topic: "spBv1.0/g/DDATA/n/d", payload },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/device/d///e/door.open");
    const body = JSON.parse(output[0].payload as string);
    expect(body.text).toContain("door.open");
    expect(body.time).toBe(ts.toISOString());
  });

  test("boolean metric only emits when value changes (report-by-exception)", () => {
    const ctx = tedge.createContext({});
    const ts = new Date("2026-02-25T10:00:00.000Z");

    const send = (value: boolean) =>
      flow.onMessage(
        {
          time: ts,
          topic: "spBv1.0/g/DDATA/n/d",
          payload: makePayload([{ name: "door.open", value }], ts.getTime()),
        },
        ctx,
      );

    // First receipt: false → emits (unknown → false)
    expect(send(false)).toHaveLength(1);
    // Same value again: no change → no output
    expect(send(false)).toHaveLength(0);
    // Value changes to true → emits
    expect(send(true)).toHaveLength(1);
    // Same value again: no change → no output
    expect(send(true)).toHaveLength(0);
    // Value changes back to false → emits
    expect(send(false)).toHaveLength(1);
  });

  test("boolean metric in BIRTH certificate is NOT forwarded as an event", () => {
    const ts = new Date("2026-02-25T10:00:00.000Z");
    const output = flow.onMessage(
      {
        time: ts,
        topic: "spBv1.0/g/DBIRTH/n/d",
        payload: makePayload([{ name: "door.open", value: true }], ts.getTime()),
      },
      tedge.createContext({}),
    );

    // BIRTH is a state snapshot — boolean events must not fire from BIRTH.
    expect(output).toHaveLength(0);
  });

  test("boolean metric name with slashes maps to underscored event type", () => {
    const ts = new Date("2026-02-25T10:00:00.000Z");
    const output = flow.onMessage(
      {
        time: ts,
        topic: "spBv1.0/g/DDATA/n/d",
        payload: makePayload([{ name: "Motor/Running", value: true }], ts.getTime()),
      },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/device/d///e/Motor_Running");
  });

  test("boolean event and numeric measurement in same DATA produce two messages", () => {
    const ts = new Date("2026-02-25T10:00:00.000Z");
    const output = flow.onMessage(
      {
        time: ts,
        topic: "spBv1.0/g/DDATA/n/d",
        payload: makePayload(
          [
            { name: "temperature", value: 42.0 },
            { name: "door.open", value: true },
          ],
          ts.getTime(),
        ),
      },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(2);
    expect(output.some((m) => m.topic.includes("///m/"))).toBe(true);
    expect(output.some((m) => m.topic === "te/device/d///e/door.open")).toBe(true);
    // Boolean must not appear in the measurement body
    const meas = output.find((m) => m.topic.includes("///m/"))!;
    expect(JSON.parse(meas.payload as string)["door.open"]).toBeUndefined();
  });
});

// ── Alarms ────────────────────────────────────────────────────────────────────

describe("sparkplug-telemetry — alarms", () => {
  test("Alarm Active=true + Text metric maps to raised alarm message", () => {
    const ts = new Date("2026-02-25T10:00:00.000Z");
    const payload = makePayload(
      [
        { name: "Alarm/HighTemp/Active", value: true },
        { name: "Alarm/HighTemp/Text", value: "Temperature exceeded 80°C" },
      ],
      ts.getTime(),
    );

    const output = flow.onMessage(
      { time: ts, topic: "spBv1.0/g/DDATA/n/sensor01", payload },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/device/sensor01///a/HighTemp");
    const body = JSON.parse(output[0].payload as string);
    expect(body.text).toBe("Temperature exceeded 80°C");
    expect(body.time).toBe(ts.toISOString());
  });

  test("Alarm Active=false produces alarm clear (empty retained message)", () => {
    const ts = new Date("2026-02-25T10:00:00.000Z");
    const payload = makePayload(
      [
        { name: "Alarm/HighTemp/Active", value: false },
        { name: "Alarm/HighTemp/Text", value: "" },
      ],
      ts.getTime(),
    );

    const output = flow.onMessage(
      { time: ts, topic: "spBv1.0/g/DDATA/n/sensor01", payload },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/device/sensor01///a/HighTemp");
    expect(output[0].payload).toBe(""); // alarm clear = empty payload
    expect(output[0].mqtt?.retain).toBe(true);
    expect(output[0].mqtt?.qos).toBe(1);
  });

  test("alarm in BIRTH certificate is NOT forwarded immediately (BIRTH is a state snapshot, not an exception)", () => {
    const ts = new Date("2026-02-25T10:00:00.000Z");
    const output = flow.onMessage(
      {
        time: ts,
        topic: "spBv1.0/g/DBIRTH/n/sensor01",
        payload: makePayload(
          [
            { name: "Alarm/LowBattery/Active", value: true },
            { name: "Alarm/LowBattery/Text", value: "battery at 5%" },
          ],
          ts.getTime(),
        ),
      },
      tedge.createContext({}),
    );

    // BIRTH carries a full state snapshot for alias registration.
    // Re-emitting all alarm states on every reconnect would flood thin-edge.io.
    // Only DATA (Report-by-Exception changes) triggers alarm output.
    expect(output).toHaveLength(0);
  });

  test("alias-resolved alarm metrics from DDATA produce correct alarm message", () => {
    const ctx = tedge.createContext({});
    const ts = new Date("2026-02-25T10:00:00.000Z");

    // BIRTH: Alarm/HighTemp/Active → alias 0, Alarm/HighTemp/Text → alias 1
    flow.onMessage(
      {
        time: ts,
        topic: "spBv1.0/g/DBIRTH/n/sensor01",
        payload: makePayload(
          [
            { name: "Alarm/HighTemp/Active", value: false, alias: 0 },
            { name: "Alarm/HighTemp/Text", value: "", alias: 1 },
          ],
          ts.getTime(),
        ),
      },
      ctx,
    );

    // DATA: alarm raised (alias only)
    const output = flow.onMessage(
      {
        time: ts,
        topic: "spBv1.0/g/DDATA/n/sensor01",
        payload: makeAliasPayload(
          [
            { alias: 0, value: true },
            { alias: 1, value: "Temperature exceeded 80°C" },
          ],
          ts.getTime(),
        ),
      },
      ctx,
    );

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/device/sensor01///a/HighTemp");
    const body = JSON.parse(output[0].payload as string);
    expect(body.text).toBe("Temperature exceeded 80°C");
  });

  test("Active=false via alias produces alarm clear", () => {
    const ctx = tedge.createContext({});
    const ts = new Date("2026-02-25T10:00:00.000Z");

    // BIRTH: establish alias mapping
    flow.onMessage(
      {
        time: ts,
        topic: "spBv1.0/g/DBIRTH/n/sensor01",
        payload: makePayload(
          [
            { name: "Alarm/HighTemp/Active", value: true, alias: 0 },
            { name: "Alarm/HighTemp/Text", value: "too hot", alias: 1 },
          ],
          ts.getTime(),
        ),
      },
      ctx,
    );

    // DATA: clear the alarm
    const output = flow.onMessage(
      {
        time: ts,
        topic: "spBv1.0/g/DDATA/n/sensor01",
        payload: makeAliasPayload(
          [
            { alias: 0, value: false },
            { alias: 1, value: "" },
          ],
          ts.getTime(),
        ),
      },
      ctx,
    );

    expect(output).toHaveLength(1);
    expect(output[0].payload).toBe("");
    expect(output[0].mqtt?.retain).toBe(true);
  });

  test("two different alarm types produce two alarm messages", () => {
    const ts = new Date("2026-02-25T10:00:00.000Z");
    const payload = makePayload(
      [
        { name: "Alarm/HighTemp/Active", value: true },
        { name: "Alarm/HighTemp/Text", value: "too hot" },
        { name: "Alarm/LowBattery/Active", value: true },
        { name: "Alarm/LowBattery/Text", value: "battery critical" },
      ],
      ts.getTime(),
    );

    const output = flow.onMessage(
      { time: ts, topic: "spBv1.0/g/DDATA/n/sensor01", payload },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(2);
    const topics = output.map((m) => m.topic).sort();
    expect(topics).toContain("te/device/sensor01///a/HighTemp");
    expect(topics).toContain("te/device/sensor01///a/LowBattery");
  });

  test("payload with measurements, event, and alarm produces three output messages", () => {
    const ts = new Date("2026-02-25T10:00:00.000Z");
    const payload = makePayload(
      [
        { name: "temperature", value: 82.0 },
        { name: "Event/overheat", value: "threshold crossed" },
        { name: "Alarm/HighTemp/Active", value: true },
        { name: "Alarm/HighTemp/Text", value: "critical temperature" },
      ],
      ts.getTime(),
    );

    const output = flow.onMessage(
      { time: ts, topic: "spBv1.0/g/DDATA/n/sensor01", payload },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(3);
    expect(output.some((m) => m.topic.includes("///m/"))).toBe(true);
    expect(output.some((m) => m.topic.includes("///e/"))).toBe(true);
    expect(output.some((m) => m.topic.includes("///a/"))).toBe(true);
  });
});

// ── Death / ignored message types ─────────────────────────────────────────────

describe("sparkplug-telemetry — ignored message types", () => {
  test("DDEATH: death messages are ignored", () => {
    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/myGroup/DDEATH/myNode/myDevice",
        payload: makePayload([{ name: "bdSeq", value: 0 }]),
      },
      tedge.createContext({}),
    );
    expect(output).toHaveLength(0);
  });

  test("NDEATH messages are ignored", () => {
    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/myGroup/NDEATH/myNode",
        payload: makePayload([{ name: "bdSeq", value: 0 }]),
      },
      tedge.createContext({}),
    );
    expect(output).toHaveLength(0);
  });

  test("NCMD messages are ignored", () => {
    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/myGroup/NCMD/myNode",
        payload: makePayload([
          { name: "Node Control/Rebirth", value: true },
        ]),
      },
      tedge.createContext({}),
    );
    expect(output).toHaveLength(0);
  });

  test("DCMD messages are ignored", () => {
    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/myGroup/DCMD/myNode/myDevice",
        payload: makePayload([{ name: "output", value: true }]),
      },
      tedge.createContext({}),
    );
    expect(output).toHaveLength(0);
  });

  test("non-sparkplug topic is ignored", () => {
    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "some/other/topic",
        payload: new Uint8Array(),
      },
      tedge.createContext({}),
    );
    expect(output).toHaveLength(0);
  });
});

// ── Real-world CNC payload ────────────────────────────────────────────────────
//
// Binary Sparkplug B NDATA captured from a sim-cnc01 edge node.
// Metrics carry their names on the wire (no alias-only encoding), so the
// flow can handle this without a prior BIRTH/alias-registry entry.
//
// Payload contains:
//   - 14 numeric/boolean measurement metrics (axis positions, spindle, coolant…)
//   - 5 event metrics  (program_start, program_end, door_open, door_close, tool_change)
//   - 3 alarm pairs   (HighHydraulicPressure, HighSpindleTemp, LowCoolantFlow) — all inactive

describe("sparkplug-telemetry — real-world CNC NDATA payload", () => {
  const PAYLOAD_B64 =
    "CIyhqNbJMxITCgZBY3RpdmUYjKGo1skzIAtwABIRCgRUZXh0GIyhqNbJMyAMegASJgoSYXhpcy54LnBvc2l0aW9uLm1tGIyhqNbJMyAKaXXVzBZ2EltAEiYKEmF4aXMueS5wb3NpdGlvbi5tbRiMoajWyTMgCmmhyCkoywxXQBImChJheGlzLnoucG9zaXRpb24ubW0YjKGo1skzIAppSzoFpklQVEASLwobY29vbGFudC5mbG93LmxpdHJlc19wZXJfbWluGIyhqNbJMyAKaXUv46qxBhRAEi8KG2Nvb2xhbnQudGVtcGVyYXR1cmUuY2Vsc2l1cxiMoajWyTMgCmlqUbF/nUk2QBIWCglkb29yLm9wZW4YjKGo1skzIAtwABIZCgxlc3RvcC5hY3RpdmUYjKGo1skzIAtwABIoChRmZWVkLnJhdGUubW1fcGVyX21pbhiMoajWyTMgCmmG1Z0yPKR3QBIqChZoeWRyYXVsaWMucHJlc3N1cmUuYmFyGIyhqNbJMyAKaYS6fsvR5mFAEhwKCHBvd2VyLmt3GIyhqNbJMyAKaeMZgS1keAFAEicKE3Byb2dyYW0uY3ljbGVfY291bnQYjKGo1skzIAppAAAAAAAAIEASJgoScHJvZ3JhbS5wYXJ0X2NvdW50GIyhqNbJMyAKaQAAAAAAACBAEiQKEHNwaW5kbGUubG9hZC5wY3QYjKGo1skzIAppfV3QianbOUASJQoRc3BpbmRsZS5zcGVlZC5ycG0YjKGo1skzIAppdMiD+ngFpkASLwobc3BpbmRsZS50ZW1wZXJhdHVyZS5jZWxzaXVzGIyhqNbJMyAKachdpxqf1D5AEjYKE0V2ZW50L3Byb2dyYW1fc3RhcnQYjKGo1skzIAx6FlN0YXJ0aW5nIE8zMDAzX1BST0ZJTEUSQQoRRXZlbnQvcHJvZ3JhbV9lbmQYjKGo1skzIAx6I08zMDAxX0NPTlRPVVIgY29tcGxldGUg4oCUIHBhcnRzOiA4Ej8KD0V2ZW50L2Rvb3Jfb3BlbhiMoajWyTMgDHojU2FmZXR5IGRvb3Igb3BlbmVkIGZvciBwYXJ0IHJlbW92YWwSLwoQRXZlbnQvZG9vcl9jbG9zZRiMoajWyTMgDHoSU2FmZXR5IGRvb3IgY2xvc2VkEjEKEUV2ZW50L3Rvb2xfY2hhbmdlGIyhqNbJMyAMehNUb29sIGNoYW5nZSDihpIgVDE1Ei8KIkFsYXJtL0hpZ2hIeWRyYXVsaWNQcmVzc3VyZS9BY3RpdmUYjKGo1skzIAtwABItCiBBbGFybS9IaWdoSHlkcmF1bGljUHJlc3N1cmUvVGV4dBiMoajWyTMgDHoAEikKHEFsYXJtL0hpZ2hTcGluZGxlVGVtcC9BY3RpdmUYjKGo1skzIAtwABInChpBbGFybS9IaWdoU3BpbmRsZVRlbXAvVGV4dBiMoajWyTMgDHoAEigKG0FsYXJtL0xvd0Nvb2xhbnRGbG93L0FjdGl2ZRiMoajWyTMgC3AAEiYKGUFsYXJtL0xvd0Nvb2xhbnRGbG93L1RleHQYjKGo1skzIAx6ABjzAQ==";
  const TOPIC = "spBv1.0/tedge/NDATA/sim-cnc01";
  const DEVICE_ID = "sim-cnc01";

  /** Decode the base64 payload exactly as the MQTT broker would deliver it:
   *  a Node.js Buffer (Uint8Array with byteOffset=0). */
  function realPayload(): Uint8Array {
    return Buffer.from(PAYLOAD_B64, "base64");
  }

  test("decodes without error and produces output messages", () => {
    const output = flow.onMessage(
      { time: new Date(), topic: TOPIC, payload: realPayload() },
      tedge.createContext({}),
    );
    // At minimum: 1 measurement + 5 text events + 2 boolean events + 3 alarm clears = 11
    expect(output.length).toBeGreaterThanOrEqual(11);
  });

  test("boolean metrics (door.open, estop.active) are emitted as events", () => {
    const output = flow.onMessage(
      { time: new Date(), topic: TOPIC, payload: realPayload() },
      tedge.createContext({}),
    );

    const eventTopics = output.filter((m) => m.topic.includes("///e/")).map((m) => m.topic);
    expect(eventTopics).toContain(`te/device/${DEVICE_ID}///e/door.open`);
    expect(eventTopics).toContain(`te/device/${DEVICE_ID}///e/estop.active`);
  });

  test("produces a measurement message with expected CNC metric keys", () => {
    const output = flow.onMessage(
      { time: new Date(), topic: TOPIC, payload: realPayload() },
      tedge.createContext({}),
    );

    const meas = output.find((m) => m.topic === `te/device/${DEVICE_ID}///m/`);
    expect(meas).toBeDefined();
    const body = JSON.parse(meas!.payload as string);

    expect(typeof body["axis.x.position.mm"]).toBe("number");
    expect(typeof body["axis.y.position.mm"]).toBe("number");
    expect(typeof body["axis.z.position.mm"]).toBe("number");
    expect(typeof body["spindle.speed.rpm"]).toBe("number");
    expect(typeof body["spindle.load.pct"]).toBe("number");
    expect(typeof body["spindle.temperature.celsius"]).toBe("number");
    expect(typeof body["coolant.flow.litres_per_min"]).toBe("number");
    expect(typeof body["coolant.temperature.celsius"]).toBe("number");
    expect(typeof body["hydraulic.pressure.bar"]).toBe("number");
    expect(typeof body["power.kw"]).toBe("number");
    expect(typeof body["feed.rate.mm_per_min"]).toBe("number");
    expect(typeof body["program.cycle_count"]).toBe("number");
    expect(typeof body["program.part_count"]).toBe("number");
    // Boolean metrics (door.open, estop.active) are emitted as events, not measurements.
    expect(body["door.open"]).toBeUndefined();
    expect(body["estop.active"]).toBeUndefined();
  });

  test("produces all 5 event messages with correct text", () => {
    const output = flow.onMessage(
      { time: new Date(), topic: TOPIC, payload: realPayload() },
      tedge.createContext({}),
    );

    const eventMsgs = output.filter((m) => m.topic.includes("///e/"));
    const eventTopics = eventMsgs.map((m) => m.topic);
    expect(eventTopics).toContain(`te/device/${DEVICE_ID}///e/program_start`);
    expect(eventTopics).toContain(`te/device/${DEVICE_ID}///e/program_end`);
    expect(eventTopics).toContain(`te/device/${DEVICE_ID}///e/door_open`);
    expect(eventTopics).toContain(`te/device/${DEVICE_ID}///e/door_close`);
    expect(eventTopics).toContain(`te/device/${DEVICE_ID}///e/tool_change`);

    const get = (type: string) =>
      JSON.parse(
        output.find((m) => m.topic === `te/device/${DEVICE_ID}///e/${type}`)!
          .payload as string,
      );

    expect(get("program_start").text).toBe("Starting O3003_PROFILE");
    expect(get("program_end").text).toContain("O3001_CONTOUR");
    expect(get("program_end").text).toContain("parts: 8");
    expect(get("door_open").text).toBe("Safety door opened for part removal");
    expect(get("door_close").text).toBe("Safety door closed");
    expect(get("tool_change").text).toContain("T15");
  });

  test("produces alarm-clear messages for all 3 inactive alarms", () => {
    const output = flow.onMessage(
      { time: new Date(), topic: TOPIC, payload: realPayload() },
      tedge.createContext({}),
    );

    const alarmMsgs = output.filter((m) => m.topic.includes("///a/"));
    const alarmTopics = alarmMsgs.map((m) => m.topic);
    expect(alarmTopics).toContain(
      `te/device/${DEVICE_ID}///a/HighHydraulicPressure`,
    );
    expect(alarmTopics).toContain(`te/device/${DEVICE_ID}///a/HighSpindleTemp`);
    expect(alarmTopics).toContain(`te/device/${DEVICE_ID}///a/LowCoolantFlow`);

    // All three alarms are inactive in this snapshot — expect clear messages
    for (const msg of alarmMsgs) {
      expect(msg.payload).toBe(""); // empty = alarm clear
      expect(msg.mqtt?.retain).toBe(true);
    }
  });
});

describe("sparkplug-telemetry — real-world CNC NBIRTH payload", () => {
  const PAYLOAD_B64 =
    // "COuexfPLMxgAEhQKBWJkU2VxGOuexfPLMxAAIAhYARInChFzcGluZGxlLnNwZWVkLnJwbRjrnsXzyzMQASAKaQAAAAAAAAAAEiYKEHNwaW5kbGUubG9hZC5wY3QY657F88szEAIgCmkAAAAAAAAAABIxChtzcGluZGxlLnRlbXBlcmF0dXJlLmNlbHNpdXMY657F88szEAMgCmmPfOx0+002QBIqChRmZWVkLnJhdGUubW1fcGVyX21pbhjrnsXzyzMQBCAKaQAAAAAAAAAAEigKEmF4aXMueC5wb3NpdGlvbi5tbRjrnsXzyzMQBSAKaQAAAAAAAAAAEigKEmF4aXMueS5wb3NpdGlvbi5tbRjrnsXzyzMQBiAKaQAAAAAAAAAAEigKEmF4aXMuei5wb3NpdGlvbi5tbRjrnsXzyzMQByAKaQAAAAAAAAAAEjEKG2Nvb2xhbnQudGVtcGVyYXR1cmUuY2Vsc2l1cxjrnsXzyzMQCCAKaR7egEqSVjRAEjEKG2Nvb2xhbnQuZmxvdy5saXRyZXNfcGVyX21pbhjrnsXzyzMQCSAKaQAAAAAAAAAAEiwKFmh5ZHJhdWxpYy5wcmVzc3VyZS5iYXIY657F88szEAogCmnU/KiyaZxhQBIeCghwb3dlci5rdxjrnsXzyzMQCyAKaZqZmZmZmdk/EiIKE3Byb2dyYW0uY3ljbGVfY291bnQY657F88szEAwgBFgAEiEKEnByb2dyYW0ucGFydF9jb3VudBjrnsXzyzMQDSAEWAASGAoJZG9vci5vcGVuGOuexfPLMxAOIAtwABIbCgxlc3RvcC5hY3RpdmUY657F88szEA8gC3AAEisKHEFsYXJtL0hpZ2hTcGluZGxlVGVtcC9BY3RpdmUY657F88szEBAgC3AAEikKGkFsYXJtL0hpZ2hTcGluZGxlVGVtcC9UZXh0GOuexfPLMxARIAx6ABIqChtBbGFybS9Mb3dDb29sYW50Rmxvdy9BY3RpdmUY657F88szEBIgC3AAEigKGUFsYXJtL0xvd0Nvb2xhbnRGbG93L1RleHQY657F88szEBMgDHoAEjEKIkFsYXJtL0hpZ2hIeWRyYXVsaWNQcmVzc3VyZS9BY3RpdmUY657F88szEBQgC3AAEi8KIEFsYXJtL0hpZ2hIeWRyYXVsaWNQcmVzc3VyZS9UZXh0GOuexfPLMxAVIAx6ABIhChJBbGFybS9FU3RvcC9BY3RpdmUY657F88szEBYgC3AAEh8KEEFsYXJtL0VTdG9wL1RleHQY657F88szEBcgDHo=";
    // "COuexfPLMxgAEhQKBWJkU2VxGOuexfPLMxAAIAhYARInChFzcGluZGxlLnNwZWVkLnJwbRjrnsXzyzMQASAKaQAAAAAAAAAAEiYKEHNwaW5kbGUubG9hZC5wY3QY657F88szEAIgCmkAAAAAAAAAABIxChtzcGluZGxlLnRlbXBlcmF0dXJlLmNlbHNpdXMY657F88szEAMgCmmPfOx0+002QBIqChRmZWVkLnJhdGUubW1fcGVyX21pbhjrnsXzyzMQBCAKaQAAAAAAAAAAEigKEmF4aXMueC5wb3NpdGlvbi5tbRjrnsXzyzMQBSAKaQAAAAAAAAAAEigKEmF4aXMueS5wb3NpdGlvbi5tbRjrnsXzyzMQBiAKaQAAAAAAAAAAEigKEmF4aXMuei5wb3NpdGlvbi5tbRjrnsXzyzMQByAKaQAAAAAAAAAAEjEKG2Nvb2xhbnQudGVtcGVyYXR1cmUuY2Vsc2l1cxjrnsXzyzMQCCAKaR7egEqSVjRAEjEKG2Nvb2xhbnQuZmxvdy5saXRyZXNfcGVyX21pbhjrnsXzyzMQCSAKaQAAAAAAAAAAEiwKFmh5ZHJhdWxpYy5wcmVzc3VyZS5iYXIY657F88szEAogCmnU/KiyaZxhQBIeCghwb3dlci5rdxjrnsXzyzMQCyAKaZqZmZmZmdk/EiIKE3Byb2dyYW0uY3ljbGVfY291bnQY657F88szEAwgBFgAEiEKEnByb2dyYW0ucGFydF9jb3VudBjrnsXzyzMQDSAEWAASGAoJZG9vci5vcGVuGOuexfPLMxAOIAtwABIbCgxlc3RvcC5hY3RpdmUY657F88szEA8gC3AAEisKHEFsYXJtL0hpZ2hTcGluZGxlVGVtcC9BY3RpdmUY657F88szEBAgC3AAEikKGkFsYXJtL0hpZ2hTcGluZGxlVGVtcC9UZXh0GOuexfPLMxARIAx6ABIqChtBbGFybS9Mb3dDb29sYW50Rmxvdy9BY3RpdmUY657F88szEBIgC3AAEigKGUFsYXJtL0xvd0Nvb2xhbnRGbG93L1RleHQY657F88szEBMgDHoAEjEKIkFsYXJtL0hpZ2hIeWRyYXVsaWNQcmVzc3VyZS9BY3RpdmUY657F88szEBQgC3AAEi8KIEFsYXJtL0hpZ2hIeWRyYXVsaWNQcmVzc3VyZS9UZXh0GOuexfPLMxAVIAx6ABIhChJBbGFybS9FU3RvcC9BY3RpdmUY657F88szEBYgC3AAEh8KEEFsYXJtL0VTdG9wL1RleHQY657F88szEBcgDHoA";
    "CIC4g6H3MhIUCgViZFNlcRAAGIC4g6H3MiAIWAASJwoRc3BpbmRsZS5zcGVlZC5ycG0QARiAuIOh9zIgCmkAAAAAAAAAABImChBzcGluZGxlLmxvYWQucGN0EAIYgLiDofcyIAppAAAAAAAAAAASMQobc3BpbmRsZS50ZW1wZXJhdHVyZS5jZWxzaXVzEAMYgLiDofcyIAppVSDNE0ujNUASKgoUZmVlZC5yYXRlLm1tX3Blcl9taW4QBBiAuIOh9zIgCmkAAAAAAAAAABIoChJheGlzLngucG9zaXRpb24ubW0QBRiAuIOh9zIgCmkAAAAAAAAAABIoChJheGlzLnkucG9zaXRpb24ubW0QBhiAuIOh9zIgCmkAAAAAAAAAABIoChJheGlzLnoucG9zaXRpb24ubW0QBxiAuIOh9zIgCmkAAAAAAAAAABIxChtjb29sYW50LnRlbXBlcmF0dXJlLmNlbHNpdXMQCBiAuIOh9zIgCmlQX1FxGvg0QBIxChtjb29sYW50LmZsb3cubGl0cmVzX3Blcl9taW4QCRiAuIOh9zIgCmkAAAAAAAAAABIsChZoeWRyYXVsaWMucHJlc3N1cmUuYmFyEAoYgLiDofcyIApp47HFsheKYUASHgoIcG93ZXIua3cQCxiAuIOh9zIgCmmamZmZmZnZPxIiChNwcm9ncmFtLmN5Y2xlX2NvdW50EAwYgLiDofcyIARYABIhChJwcm9ncmFtLnBhcnRfY291bnQQDRiAuIOh9zIgBFgAEhgKCWRvb3Iub3BlbhAOGIC4g6H3MiALcAASGwoMZXN0b3AuYWN0aXZlEA8YgLiDofcyIAtwABIrChxBbGFybS9IaWdoU3BpbmRsZVRlbXAvQWN0aXZlEBAYgLiDofcyIAtwABIpChpBbGFybS9IaWdoU3BpbmRsZVRlbXAvVGV4dBARGIC4g6H3MiAMegASKgobQWxhcm0vTG93Q29vbGFudEZsb3cvQWN0aXZlEBIYgLiDofcyIAtwABIoChlBbGFybS9Mb3dDb29sYW50Rmxvdy9UZXh0EBMYgLiDofcyIAx6ABIxCiJBbGFybS9IaWdoSHlkcmF1bGljUHJlc3N1cmUvQWN0aXZlEBQYgLiDofcyIAtwABIvCiBBbGFybS9IaWdoSHlkcmF1bGljUHJlc3N1cmUvVGV4dBAVGIC4g6H3MiAMegASIQoSQWxhcm0vRVN0b3AvQWN0aXZlEBYYgLiDofcyIAtwABIfChBBbGFybS9FU3RvcC9UZXh0EBcYgLiDofcyIAx6ABgA";
    // NDATA message is ok
    // "CPnwrvXLMxINEAEgCmkQsYiN6liwQBINEAIgCmkJQ7YLG21DQBINEAMgCmk9lEQt6Yc+QBINEAQgCmkAAAAAAAAAABINEAUgCmlfA492P4t6QBINEAYgCmmAFnYh9JxRQBINEAcgCml3Pe2ZRqJKQBINEAggCmk8fZaoQUM2QBINEAkgCmmY2kjKNpISQBINEAogCmlLIfVW+eJiQBINEAsgCmmeEB51fpQDQBIGEAwgBFgBEgYQDSAEWAESBhAOIAtwARIGEA8gC3AAEgYQECALcAASBhARIAx6ABIGEBIgC3AAEgYQEyAMegASBhAUIAtwABIGEBUgDHoAEgYQFiALcAASBhAXIAx6ABgO";
  const TOPIC = "spBv1.0/tedge/NBIRTH/sim-cnc01";
  const DEVICE_ID = "sim-cnc01";

  /** Decode the base64 payload exactly as the MQTT broker would deliver it:
   *  a Node.js Buffer (Uint8Array with byteOffset=0). */
  function realPayload(): Uint8Array {
    return Buffer.from(PAYLOAD_B64, "base64");
  }

  test("NBIRTH produces no output — it is a state snapshot for alias registration only", () => {
    const output = flow.onMessage(
      { time: new Date(), topic: TOPIC, payload: realPayload() },
      tedge.createContext({}),
    );
    expect(output).toHaveLength(0);
  });
});

