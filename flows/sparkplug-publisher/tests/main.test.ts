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

/** Find a message in output whose topic contains the given Sparkplug B command (e.g. "DDATA"). */
function findMsg(output: ReturnType<typeof flow.onMessage>, cmd: string) {
  return output.find((m) => m.topic.includes(`/${cmd}/`));
}

describe("sparkplug-publisher", () => {
  // ── Birth / death certificates ────────────────────────────────────────────

  test("first message from a device emits DBIRTH followed by DDATA", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      makeMessage("te/device/sensor01///m/", { temperature: 23.5 }),
      ctx,
    );

    // Two messages: [DBIRTH, DDATA]
    expect(output).toHaveLength(2);
    expect(output[0].topic).toBe(
      "spBv1.0/my-factory/DBIRTH/gateway01/sensor01",
    );
    expect(output[1].topic).toBe("spBv1.0/my-factory/DDATA/gateway01/sensor01");
  });

  test("BIRTH message is published as a retained MQTT message", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      makeMessage("te/device/sensor01///m/", { temperature: 23.5 }),
      ctx,
    );
    const birth = findMsg(output, "DBIRTH")!;
    expect(birth.mqtt?.retain).toBe(true);
    expect(birth.mqtt?.qos).toBe(1);
  });

  test("BIRTH metrics carry both full name and alias; DATA metrics carry alias only", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      makeMessage("te/device/sensor01///m/", { temperature: 23.5 }),
      ctx,
    );

    const birthPayload = fromBinary(
      PayloadSchema,
      findMsg(output, "DBIRTH")!.payload as Uint8Array,
    );
    expect(birthPayload.metrics[0].name).toBe("temperature");
    // alias is a bigint; any defined value is valid
    expect(typeof birthPayload.metrics[0].alias).toBe("bigint");

    const dataPayload = fromBinary(
      PayloadSchema,
      findMsg(output, "DDATA")!.payload as Uint8Array,
    );
    // DATA must not repeat the name — consumers use the BIRTH alias map
    expect(dataPayload.metrics[0].name).toBe("");
    expect(dataPayload.metrics[0].alias).toBe(birthPayload.metrics[0].alias);
  });

  test("second message from same device emits DDATA only (no BIRTH)", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const msg = () =>
      makeMessage("te/device/sensor01///m/", { temperature: 23.5 });

    flow.onMessage(msg(), ctx); // first — triggers birth
    const second = flow.onMessage(msg(), ctx);

    expect(second).toHaveLength(1);
    expect(second[0].topic).toContain("/DDATA/");
    expect(second[0].mqtt?.retain).toBeUndefined();
  });

  test("new metric appearing on a subsequent message re-issues BIRTH", () => {
    const ctx = tedge.createContext(BASE_CONFIG);

    flow.onMessage(
      makeMessage("te/device/sensor01///m/", { temperature: 23.5 }),
      ctx,
    );
    const output2 = flow.onMessage(
      makeMessage("te/device/sensor01///m/", {
        temperature: 24.0,
        humidity: 60.0, // new metric
      }),
      ctx,
    );

    // BIRTH re-issued because alias registry grew
    expect(output2).toHaveLength(2);
    const birth2 = fromBinary(
      PayloadSchema,
      findMsg(output2, "DBIRTH")!.payload as Uint8Array,
    );
    const names = birth2.metrics.map((m) => m.name);
    expect(names).toContain("temperature");
    expect(names).toContain("humidity");
  });

  test("alias assigned at first BIRTH is reused unchanged in later DATA", () => {
    const ctx = tedge.createContext(BASE_CONFIG);

    const first = flow.onMessage(
      makeMessage("te/device/sensor01///m/", { temperature: 23.5 }),
      ctx,
    );
    const birthAlias = fromBinary(
      PayloadSchema,
      findMsg(first, "DBIRTH")!.payload as Uint8Array,
    ).metrics[0].alias;

    const second = flow.onMessage(
      makeMessage("te/device/sensor01///m/", { temperature: 24.0 }),
      ctx,
    );
    const dataAlias = fromBinary(PayloadSchema, second[0].payload as Uint8Array)
      .metrics[0].alias;

    expect(dataAlias).toBe(birthAlias);
  });

  test("different devices have independent alias registries", () => {
    const ctx = tedge.createContext(BASE_CONFIG);

    flow.onMessage(
      makeMessage("te/device/sensor01///m/", { temperature: 1.0 }),
      ctx,
    );
    const out2 = flow.onMessage(
      makeMessage("te/device/sensor02///m/", { temperature: 2.0 }),
      ctx,
    );

    // sensor02 triggers its own BIRTH (independent of sensor01)
    expect(out2).toHaveLength(2);
    expect(out2[0].topic).toContain("sensor02");
  });

  // ── Topic / metric mapping ────────────────────────────────────────────────

  test("child device maps to DDATA topic", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      makeMessage("te/device/sensor01///m/", {
        time: "2026-02-25T10:00:00.000Z",
        temperature: 23.5,
        humidity: 60.0,
      }),
      ctx,
    );

    const data = findMsg(output, "DDATA")!;
    expect(data.topic).toBe("spBv1.0/my-factory/DDATA/gateway01/sensor01");

    // BIRTH carries metric names so consumers can build the alias map
    const birth = fromBinary(
      PayloadSchema,
      findMsg(output, "DBIRTH")!.payload as Uint8Array,
    );
    expect(birth.metrics).toHaveLength(2);
    const names = birth.metrics.map((m) => m.name);
    expect(names).toContain("temperature");
    expect(names).toContain("humidity");

    // DATA carries values (via alias)
    const dataPayload = fromBinary(PayloadSchema, data.payload as Uint8Array);
    expect(dataPayload.metrics).toHaveLength(2);
    const tempData = dataPayload.metrics.find(
      (m) =>
        m.alias === birth.metrics.find((b) => b.name === "temperature")!.alias,
    )!;
    expect(tempData.value.case).toBe("doubleValue");
    expect(tempData.value.value).toBeCloseTo(23.5);
  });

  test("edge node device maps to NBIRTH + NDATA topics", () => {
    const ctx = tedge.createContext({
      ...BASE_CONFIG,
      edgeNodeId: "gateway01",
    });
    const output = flow.onMessage(
      makeMessage("te/device/gateway01///m/", { temperature: 22.0 }),
      ctx,
    );

    expect(findMsg(output, "NBIRTH")!.topic).toBe(
      "spBv1.0/my-factory/NBIRTH/gateway01",
    );
    expect(findMsg(output, "NDATA")!.topic).toBe(
      "spBv1.0/my-factory/NDATA/gateway01",
    );
  });

  test("named measurement type: BIRTH carries the correct metric name", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      makeMessage("te/device/plc01///m/environment", {
        time: "2026-02-25T10:00:00.000Z",
        co2: 412.0,
      }),
      ctx,
    );

    const birth = fromBinary(
      PayloadSchema,
      findMsg(output, "DBIRTH")!.payload as Uint8Array,
    );
    expect(birth.metrics[0].name).toBe("co2");
  });

  test("boolean and string values are mapped to correct Sparkplug B datatypes", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      makeMessage("te/device/sensor01///m/", {
        active: true,
        status: "ok",
      }),
      ctx,
    );

    const birth = fromBinary(
      PayloadSchema,
      findMsg(output, "DBIRTH")!.payload as Uint8Array,
    );
    const activeB = birth.metrics.find((m) => m.name === "active")!;
    expect(activeB.datatype).toBe(11); // Boolean
    expect(activeB.value.case).toBe("booleanValue");

    const statusB = birth.metrics.find((m) => m.name === "status")!;
    expect(statusB.datatype).toBe(12); // String
    expect(statusB.value.case).toBe("stringValue");
  });

  // ── Timestamps ────────────────────────────────────────────────────────────

  test("payload timestamp propagates to BIRTH and DATA", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      makeMessage(
        "te/device/sensor01///m/",
        { time: "2026-01-15T08:30:00.000Z", temperature: 20.0 },
        new Date("2026-01-15T09:00:00.000Z"), // later receive time
      ),
      ctx,
    );

    const expectedTs = new Date("2026-01-15T08:30:00.000Z").getTime();

    for (const msg of output) {
      const sp = fromBinary(PayloadSchema, msg.payload as Uint8Array);
      expect(Number(sp.timestamp)).toBe(expectedTs);
      expect(Number(sp.metrics[0].timestamp)).toBe(expectedTs);
    }
  });

  // ── Sequence numbers ──────────────────────────────────────────────────────

  test("BIRTH gets seq=0, first DATA gets seq=1, second DATA gets seq=2", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const msg = () => makeMessage("te/device/sensor01///m/", { value: 1.0 });

    const first = flow.onMessage(msg(), ctx);
    const birth = fromBinary(
      PayloadSchema,
      findMsg(first, "DBIRTH")!.payload as Uint8Array,
    );
    const data1 = fromBinary(
      PayloadSchema,
      findMsg(first, "DDATA")!.payload as Uint8Array,
    );
    expect(Number(birth.seq)).toBe(0);
    expect(Number(data1.seq)).toBe(1);

    const second = flow.onMessage(msg(), ctx);
    const data2 = fromBinary(PayloadSchema, second[0].payload as Uint8Array);
    expect(Number(data2.seq)).toBe(2);
  });

  test("sequence number wraps at 256", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const msg = () => makeMessage("te/device/sensor01///m/", { value: 1.0 });

    // First call: birth(seq=0) + data(seq=1) — consumes two sequence numbers.
    // Subsequent calls: data only (one seq each).
    // Call k (k≥2) uses seq=k, so call 255 uses seq=255 and call 256 uses seq=0.
    for (let i = 0; i < 254; i++) {
      flow.onMessage(msg(), ctx);
    }
    const at255 = flow.onMessage(msg(), ctx);
    const sp255 = fromBinary(PayloadSchema, at255[0].payload as Uint8Array);
    expect(Number(sp255.seq)).toBe(255);

    const at0 = flow.onMessage(msg(), ctx);
    const sp0 = fromBinary(PayloadSchema, at0[0].payload as Uint8Array);
    expect(Number(sp0.seq)).toBe(0);
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

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
      makeMessage("te/device/sensor01///m/", {
        time: "2026-02-25T10:00:00.000Z",
      }),
      ctx,
    );
    expect(output).toHaveLength(0);
  });
});
