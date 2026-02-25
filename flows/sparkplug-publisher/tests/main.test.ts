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

  test("non-tedge topics are ignored", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "sensors/device/sensor01/data",
        payload: "{}",
      },
      ctx,
    );
    expect(output).toHaveLength(0);
  });

  test("unsupported channel types (e.g. s/) are ignored", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "te/device/sensor01///s/status",
        payload: "{}",
      },
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

describe("sparkplug-publisher — re-BIRTH completeness", () => {
  test("re-issued BIRTH contains all previously seen metrics, not just new ones", () => {
    const ctx = tedge.createContext(BASE_CONFIG);

    // First message: establishes temperature in registry with value 23.5
    flow.onMessage(
      makeMessage("te/device/sensor01///m/", { temperature: 23.5 }),
      ctx,
    );

    // Second message: different metric only — triggers re-BIRTH because humidity is new.
    // temperature is NOT in this message, so re-BIRTH must use the last-known stored value.
    const output2 = flow.onMessage(
      makeMessage("te/device/sensor01///m/", { humidity: 60.0 }),
      ctx,
    );

    expect(output2).toHaveLength(2); // BIRTH + DATA
    const birth2 = fromBinary(
      PayloadSchema,
      findMsg(output2, "DBIRTH")!.payload as Uint8Array,
    );

    // BIRTH must contain both temperature (old) and humidity (new)
    const names = birth2.metrics.map((m) => m.name);
    expect(names).toContain("temperature");
    expect(names).toContain("humidity");

    // Old metric's last known value (23.5) should be replayed in the re-BIRTH
    const tempInBirth = birth2.metrics.find((m) => m.name === "temperature")!;
    expect(tempInBirth.value.case).toBe("doubleValue");
    expect((tempInBirth.value as { value: number }).value).toBeCloseTo(23.5);
  });
});

describe("sparkplug-publisher — events", () => {
  test("event emits DBIRTH + DDATA with Event/{type} String metric", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      makeMessage("te/device/sensor01///e/login", {
        text: "user admin logged in",
        time: "2026-02-25T10:00:00.000Z",
      }),
      ctx,
    );

    expect(output).toHaveLength(2);
    expect(findMsg(output, "DBIRTH")!.topic).toBe(
      "spBv1.0/my-factory/DBIRTH/gateway01/sensor01",
    );
    expect(findMsg(output, "DDATA")!.topic).toBe(
      "spBv1.0/my-factory/DDATA/gateway01/sensor01",
    );

    const birth = fromBinary(
      PayloadSchema,
      findMsg(output, "DBIRTH")!.payload as Uint8Array,
    );
    expect(birth.metrics).toHaveLength(1);
    expect(birth.metrics[0].name).toBe("Event/login");
    expect(birth.metrics[0].datatype).toBe(12); // String
    expect(birth.metrics[0].value.case).toBe("stringValue");
    expect((birth.metrics[0].value as { value: string }).value).toBe(
      "user admin logged in",
    );

    // DATA carries alias only (no name on wire)
    const data = fromBinary(
      PayloadSchema,
      findMsg(output, "DDATA")!.payload as Uint8Array,
    );
    expect(data.metrics[0].name).toBe("");
    expect(data.metrics[0].alias).toBe(birth.metrics[0].alias);
  });

  test("event without text field uses empty string", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      makeMessage("te/device/sensor01///e/heartbeat", {}),
      ctx,
    );

    const birth = fromBinary(
      PayloadSchema,
      findMsg(output, "DBIRTH")!.payload as Uint8Array,
    );
    expect((birth.metrics[0].value as { value: string }).value).toBe("");
  });

  test("second event of same type emits DDATA only (no re-BIRTH)", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const msg = () =>
      makeMessage("te/device/sensor01///e/login", { text: "logged in" });
    flow.onMessage(msg(), ctx);
    const second = flow.onMessage(msg(), ctx);
    expect(second).toHaveLength(1);
    expect(second[0].topic).toContain("/DDATA/");
  });

  test("edge node event maps to NBIRTH + NDATA", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      makeMessage("te/device/gateway01///e/reboot", { text: "rebooted" }),
      ctx,
    );
    expect(findMsg(output, "NBIRTH")!.topic).toBe(
      "spBv1.0/my-factory/NBIRTH/gateway01",
    );
    expect(findMsg(output, "NDATA")!.topic).toBe(
      "spBv1.0/my-factory/NDATA/gateway01",
    );
  });

  test("event and measurement metrics share the same device alias registry", () => {
    const ctx = tedge.createContext(BASE_CONFIG);

    // Seed registry with a measurement
    const firstOut = flow.onMessage(
      makeMessage("te/device/sensor01///m/", { temperature: 23.5 }),
      ctx,
    );
    const measAlias = fromBinary(
      PayloadSchema,
      findMsg(firstOut, "DBIRTH")!.payload as Uint8Array,
    ).metrics[0].alias;

    // An event adds a new metric → re-BIRTH with both
    const eventOut = flow.onMessage(
      makeMessage("te/device/sensor01///e/alert", { text: "overheated" }),
      ctx,
    );
    expect(eventOut).toHaveLength(2); // re-BIRTH triggered
    const reBirth = fromBinary(
      PayloadSchema,
      findMsg(eventOut, "DBIRTH")!.payload as Uint8Array,
    );
    // temperature should retain its original alias
    const tempMeta = reBirth.metrics.find((m) => m.name === "temperature")!;
    expect(tempMeta.alias).toBe(measAlias);
    // event metric gets the next alias
    const eventMeta = reBirth.metrics.find((m) => m.name === "Event/alert")!;
    expect(eventMeta).toBeDefined();
  });
});

describe("sparkplug-publisher — alarms", () => {
  test("raised alarm emits DBIRTH + DDATA with Active=true and Text set", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      makeMessage("te/device/sensor01///a/HighTemp", {
        text: "Temperature exceeded 80°C",
        severity: "critical",
        time: "2026-02-25T10:00:00.000Z",
      }),
      ctx,
    );

    expect(output).toHaveLength(2);
    const birth = fromBinary(
      PayloadSchema,
      findMsg(output, "DBIRTH")!.payload as Uint8Array,
    );

    expect(birth.metrics).toHaveLength(2);
    const names = birth.metrics.map((m) => m.name).sort();
    expect(names).toEqual(["Alarm/HighTemp/Active", "Alarm/HighTemp/Text"]);

    const active = birth.metrics.find(
      (m) => m.name === "Alarm/HighTemp/Active",
    )!;
    expect(active.datatype).toBe(11); // Boolean
    expect((active.value as { value: boolean }).value).toBe(true);

    const textM = birth.metrics.find((m) => m.name === "Alarm/HighTemp/Text")!;
    expect(textM.datatype).toBe(12); // String
    expect((textM.value as { value: string }).value).toBe(
      "Temperature exceeded 80°C",
    );
  });

  test("cleared alarm (empty payload) emits DDATA with Active=false and empty Text", () => {
    const ctx = tedge.createContext(BASE_CONFIG);

    // First raise the alarm to seed the registry
    flow.onMessage(
      makeMessage("te/device/sensor01///a/HighTemp", {
        text: "Temperature exceeded 80°C",
      }),
      ctx,
    );

    // Now clear it — thin-edge.io style: publish empty retained message
    const clearOut = flow.onMessage(
      {
        time: new Date("2026-02-25T10:00:00.000Z"),
        topic: "te/device/sensor01///a/HighTemp",
        payload: "",
      },
      ctx,
    );

    expect(clearOut).toHaveLength(1); // DATA only (schema unchanged)
    const data = fromBinary(PayloadSchema, clearOut[0].payload as Uint8Array);
    expect(data.metrics).toHaveLength(2);

    // Active=false, Text="" — order matches insertion order (Active first)
    const activeMetric = data.metrics[0];
    const textMetric = data.metrics[1];
    expect((activeMetric.value as { value: boolean }).value).toBe(false);
    expect((textMetric.value as { value: string }).value).toBe("");
  });

  test("empty retained payload (thin-edge.io alarm clear) produces Active=false DDATA", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    flow.onMessage(
      makeMessage("te/device/sensor01///a/HighTemp", { text: "too hot" }),
      ctx,
    );
    const clearOut = flow.onMessage(
      {
        time: new Date(),
        topic: "te/device/sensor01///a/HighTemp",
        payload: "",
      },
      ctx,
    );
    expect(clearOut).toHaveLength(1);
    const data = fromBinary(PayloadSchema, clearOut[0].payload as Uint8Array);
    const active = data.metrics.find(
      (m) => m.alias === BigInt(0), // Active was assigned alias 0
    );
    // Just verify Active=false is in the payload
    const booleanMetrics = data.metrics.filter(
      (m) => (m.value as { case: string }).case === "booleanValue",
    );
    expect(booleanMetrics).toHaveLength(1);
    expect((booleanMetrics[0].value as { value: boolean }).value).toBe(false);
  });

  test("empty payload on a non-alarm topic is ignored", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const out = flow.onMessage(
      { time: new Date(), topic: "te/device/sensor01///m/raw", payload: "" },
      ctx,
    );
    expect(out).toHaveLength(0);
  });

  test("alarm clear before any raise still produces output with Active=false", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const output = flow.onMessage(
      // Use empty string (thin-edge.io style clear) — device not yet in registry
      {
        time: new Date("2026-02-25T10:00:00.000Z"),
        topic: "te/device/sensor01///a/HighTemp",
        payload: "",
      },
      ctx,
    );

    // No prior state — BIRTH is issued (first time device seen)
    expect(output).toHaveLength(2);
    const birth = fromBinary(
      PayloadSchema,
      findMsg(output, "DBIRTH")!.payload as Uint8Array,
    );
    const active = birth.metrics.find(
      (m) => m.name === "Alarm/HighTemp/Active",
    )!;
    expect((active.value as { value: boolean }).value).toBe(false);
  });

  test("second alarm of same type emits DDATA only", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    const msg = () =>
      makeMessage("te/device/sensor01///a/HighTemp", {
        text: "still hot",
      });
    flow.onMessage(msg(), ctx);
    const second = flow.onMessage(msg(), ctx);
    expect(second).toHaveLength(1);
    expect(second[0].topic).toContain("/DDATA/");
  });

  test("two different alarm types get independent metric pairs", () => {
    const ctx = tedge.createContext(BASE_CONFIG);
    flow.onMessage(
      makeMessage("te/device/sensor01///a/HighTemp", { text: "hot" }),
      ctx,
    );
    const out2 = flow.onMessage(
      makeMessage("te/device/sensor01///a/LowBattery", { text: "low" }),
      ctx,
    );

    // LowBattery triggers re-BIRTH because it adds 2 new metrics
    expect(out2).toHaveLength(2);
    const birth = fromBinary(
      PayloadSchema,
      findMsg(out2, "DBIRTH")!.payload as Uint8Array,
    );
    const names = birth.metrics.map((m) => m.name).sort();
    expect(names).toContain("Alarm/HighTemp/Active");
    expect(names).toContain("Alarm/HighTemp/Text");
    expect(names).toContain("Alarm/LowBattery/Active");
    expect(names).toContain("Alarm/LowBattery/Text");
  });

  test("cleared alarm shows Active=false in re-BIRTH triggered by a new alarm", () => {
    // Regression: clearing an alarm (DATA-only) must persist lastValue so that
    // a subsequent re-BIRTH (triggered by a new metric) reflects the cleared state.
    const ctx = tedge.createContext(BASE_CONFIG);

    // 1. Raise HighTemp
    flow.onMessage(
      makeMessage("te/device/sensor01///a/HighTemp", {
        text: "too hot",
      }),
      ctx,
    );

    // 2. Clear HighTemp — emits DDATA only (Active=false), no new metrics
    flow.onMessage(
      {
        time: new Date(),
        topic: "te/device/sensor01///a/HighTemp",
        payload: "",
      },
      ctx,
    );

    // 3. Raise a NEW alarm type — triggers re-BIRTH because new metrics appear
    const rebirthOut = flow.onMessage(
      makeMessage("te/device/sensor01///a/LowCoolant", {
        text: "coolant low",
      }),
      ctx,
    );

    expect(rebirthOut).toHaveLength(2); // DBIRTH + DDATA

    const birth = fromBinary(
      PayloadSchema,
      findMsg(rebirthOut, "DBIRTH")!.payload as Uint8Array,
    );

    // The re-BIRTH must carry HighTemp/Active=false (cleared), not true (stale)
    const highTempActive = birth.metrics.find(
      (m) => m.name === "Alarm/HighTemp/Active",
    )!;
    expect(highTempActive).toBeDefined();
    expect((highTempActive.value as { value: boolean }).value).toBe(false);

    // And the new LowCoolant alarm should be Active=true
    const coolantActive = birth.metrics.find(
      (m) => m.name === "Alarm/LowCoolant/Active",
    )!;
    expect(coolantActive).toBeDefined();
    expect((coolantActive.value as { value: boolean }).value).toBe(true);
  });
});
