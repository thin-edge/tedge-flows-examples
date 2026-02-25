import { expect, test, describe } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";
import { fromBinary } from "@bufbuild/protobuf";
import { PayloadSchema } from "../src/gen/sparkplug_b_pb";

const BASE_CONFIG = {
  groupId: "my-factory",
  edgeNodeId: "gateway01",
};

function makeMessage(
  topic: string,
  payload: Record<string, unknown>,
  time = new Date("2026-02-25T10:00:00.000Z"),
) {
  return { time, topic, payload: JSON.stringify(payload) };
}

describe("sparkplug-publisher", () => {
  test("child device DDATA: thin-edge.io measurements become Sparkplug B metrics", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      makeMessage("te/device/sensor01///m/", {
        time: "2026-02-25T10:00:00.000Z",
        temperature: 23.5,
        humidity: 60.0,
      }),
      ctx,
    );

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe(
      "spBv1.0/my-factory/DDATA/gateway01/sensor01",
    );

    const spPayload = fromBinary(
      PayloadSchema,
      output[0].payload as Uint8Array,
    );
    expect(spPayload.metrics).toHaveLength(2);

    const names = spPayload.metrics.map((m) => m.name);
    expect(names).toContain("temperature");
    expect(names).toContain("humidity");

    const tempMetric = spPayload.metrics.find((m) => m.name === "temperature")!;
    expect(tempMetric.value.case).toBe("doubleValue");
    expect(tempMetric.value.value).toBeCloseTo(23.5);
    expect(tempMetric.datatype).toBe(10); // Double

    const humMetric = spPayload.metrics.find((m) => m.name === "humidity")!;
    expect(humMetric.value.case).toBe("doubleValue");
    expect(humMetric.value.value).toBeCloseTo(60.0);
  });

  test("edge node device maps to NDATA topic", () => {
    const ctx = tedge.createContext({ ...BASE_CONFIG, edgeNodeId: "gateway01" });
    const output = flow.onMessage(
      makeMessage("te/device/gateway01///m/", { temperature: 22.0 }),
      ctx,
    );

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("spBv1.0/my-factory/NDATA/gateway01");
  });

  test("named measurement type is forwarded correctly", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      makeMessage("te/device/plc01///m/environment", {
        time: "2026-02-25T10:00:00.000Z",
        co2: 412.0,
      }),
      ctx,
    );

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe(
      "spBv1.0/my-factory/DDATA/gateway01/plc01",
    );
    const spPayload = fromBinary(PayloadSchema, output[0].payload as Uint8Array);
    expect(spPayload.metrics[0].name).toBe("co2");
  });

  test("boolean and string values are mapped to correct Sparkplug B types", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      makeMessage("te/device/sensor01///m/", {
        active: true,
        status: "ok",
      }),
      ctx,
    );

    const spPayload = fromBinary(PayloadSchema, output[0].payload as Uint8Array);
    const activeMetric = spPayload.metrics.find((m) => m.name === "active")!;
    expect(activeMetric.value.case).toBe("booleanValue");
    expect(activeMetric.datatype).toBe(11); // Boolean

    const statusMetric = spPayload.metrics.find((m) => m.name === "status")!;
    expect(statusMetric.value.case).toBe("stringValue");
    expect(statusMetric.datatype).toBe(12); // String
  });

  test("payload timestamp propagates to metric timestamps", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      makeMessage(
        "te/device/sensor01///m/",
        { time: "2026-01-15T08:30:00.000Z", temperature: 20.0 },
        new Date("2026-01-15T09:00:00.000Z"), // later receive time
      ),
      ctx,
    );

    const spPayload = fromBinary(PayloadSchema, output[0].payload as Uint8Array);
    expect(Number(spPayload.timestamp)).toBe(
      new Date("2026-01-15T08:30:00.000Z").getTime(),
    );
    expect(Number(spPayload.metrics[0].timestamp)).toBe(
      new Date("2026-01-15T08:30:00.000Z").getTime(),
    );
  });

  test("sequence number increments and wraps at 256", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const msg = () =>
      makeMessage("te/device/sensor01///m/", { value: 1.0 });

    // Advance to seq 255
    for (let i = 0; i < 255; i++) {
      flow.onMessage(msg(), ctx);
    }
    const at255 = flow.onMessage(msg(), ctx);
    const sp255 = fromBinary(PayloadSchema, at255[0].payload as Uint8Array);
    expect(Number(sp255.seq)).toBe(255);

    // Next should wrap back to 0
    const at0 = flow.onMessage(msg(), ctx);
    const sp0 = fromBinary(PayloadSchema, at0[0].payload as Uint8Array);
    expect(Number(sp0.seq)).toBe(0);
  });

  test("non-measurement topics are ignored", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      { time: new Date(), topic: "te/device/sensor01///a/", payload: "{}" },
      ctx,
    );
    expect(output).toHaveLength(0);
  });

  test("empty payload with no measurements returns no output", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      makeMessage("te/device/sensor01///m/", { time: "2026-02-25T10:00:00.000Z" }),
      ctx,
    );
    expect(output).toHaveLength(0);
  });
});

