import { expect, test, describe } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";
import { create, toBinary } from "@bufbuild/protobuf";
import { PayloadSchema, Payload_MetricSchema } from "../src/gen/sparkplug_b_pb";

// Helper to build a binary Sparkplug B payload
function makePayload(
  metrics: { name: string; value: number | boolean | string }[],
  timestampMs?: number,
): Uint8Array {
  return toBinary(
    PayloadSchema,
    create(PayloadSchema, {
      timestamp: timestampMs !== undefined ? BigInt(timestampMs) : BigInt(0),
      metrics: metrics.map(({ name, value }) => {
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
        return create(Payload_MetricSchema, { name, value: v });
      }),
    }),
  );
}

describe("sparkplug-telemetry", () => {
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

  test("DBIRTH: birth certificate metrics are forwarded as measurements", () => {
    const payload = makePayload([{ name: "voltage", value: 230.1 }]);

    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/factory/DBIRTH/gateway/sensor01",
        payload,
      },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/device/sensor01///m/");
    const body = JSON.parse(output[0].payload as string);
    expect(body.voltage).toBeCloseTo(230.1);
  });

  test("boolean and string metric values are mapped correctly", () => {
    const payload = makePayload([
      { name: "active", value: true },
      { name: "status", value: "ok" },
    ]);

    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/g/DDATA/n/d",
        payload,
      },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(1);
    const body = JSON.parse(output[0].payload as string);
    expect(body.active).toBe(true);
    expect(body.status).toBe("ok");
  });

  test("DDEATH: death messages are ignored", () => {
    const payload = makePayload([{ name: "temperature", value: 0 }]);

    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/myGroup/DDEATH/myNode/myDevice",
        payload,
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

  test("payload timestamp takes precedence over message receive time", () => {
    const payloadTs = new Date("2026-01-15T08:30:00.000Z");
    const messageTs = new Date("2026-01-15T09:00:00.000Z"); // later than payload
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
