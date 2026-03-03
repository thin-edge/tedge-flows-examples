import { expect, test, describe } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  PayloadSchema,
  Payload_MetricSchema,
} from "../../sparkplug-telemetry/src/gen/sparkplug_b_pb";

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

describe("sparkplug-c8y-telemetry", () => {
  test("DDATA: maps Temperature metric to Cumulocity measurement", () => {
    const timestamp = new Date("2026-02-25T10:00:00.000Z");
    const payload = makePayload(
      [{ name: "Temperature", value: 85.5 }],
      timestamp.getTime(),
    );

    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/factory/DDATA/gateway/sensor01",
        payload,
      },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("c8y/measurement/measurements/create");

    const [measurement] = JSON.parse(output[0].payload as string);
    expect(measurement.cumulocityType).toBe("measurement");
    expect(measurement.externalSource).toEqual([
      { externalId: "sensor01", type: "c8y_Serial" },
    ]);
    expect(measurement.payload.time).toBe("2026-02-25T10:00:00.000Z");
    expect(measurement.payload.source).toEqual({ id: "12345" });
    expect(measurement.payload.type).toBe("c8y_TemperatureMeasurement");
    expect(measurement.payload.c8y_Steam.Temperature.unit).toBe("C");
    expect(measurement.payload.c8y_Steam.Temperature.value).toBeCloseTo(85.5);
  });

  test("NDATA: uses edge node ID as externalId when no device ID", () => {
    const payload = makePayload([{ name: "Temperature", value: 20.0 }]);

    const output = flow.onMessage(
      {
        time: new Date("2026-02-25T10:00:00.000Z"),
        topic: "spBv1.0/factory/NDATA/myNode",
        payload,
      },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(1);
    const [measurement] = JSON.parse(output[0].payload as string);
    expect(measurement.externalSource[0].externalId).toBe("myNode");
  });

  test("DBIRTH: birth certificate temperature metric is forwarded", () => {
    const payload = makePayload([{ name: "Temperature", value: 22.3 }]);

    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/factory/DBIRTH/gateway/sensor01",
        payload,
      },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(1);
    const [measurement] = JSON.parse(output[0].payload as string);
    expect(measurement.payload.c8y_Steam.Temperature.value).toBeCloseTo(22.3);
  });

  test("custom sourceId is used when configured", () => {
    const payload = makePayload([{ name: "Temperature", value: 100.0 }]);

    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/g/DDATA/n/d",
        payload,
      },
      tedge.createContext({ sourceId: "99999" }),
    );

    expect(output).toHaveLength(1);
    const [measurement] = JSON.parse(output[0].payload as string);
    expect(measurement.payload.source.id).toBe("99999");
  });

  test("custom temperatureUnit is used when configured", () => {
    const payload = makePayload([{ name: "Temperature", value: 212.0 }]);

    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/g/DDATA/n/d",
        payload,
      },
      tedge.createContext({ temperatureUnit: "F" }),
    );

    expect(output).toHaveLength(1);
    const [measurement] = JSON.parse(output[0].payload as string);
    expect(measurement.payload.c8y_Steam.Temperature.unit).toBe("F");
  });

  test("custom temperatureMetricName matches configured metric", () => {
    const payload = makePayload([{ name: "sensorData/temp_val", value: 75.0 }]);

    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/g/DDATA/n/d",
        payload,
      },
      tedge.createContext({ temperatureMetricName: "sensorData/temp_val" }),
    );

    expect(output).toHaveLength(1);
    const [measurement] = JSON.parse(output[0].payload as string);
    expect(measurement.payload.c8y_Steam.Temperature.value).toBeCloseTo(75.0);
  });

  test("no Temperature metric returns empty array", () => {
    const payload = makePayload([
      { name: "humidity", value: 60 },
      { name: "pressure", value: 1013 },
    ]);

    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/g/DDATA/n/d",
        payload,
      },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(0);
  });

  test("DDEATH: death messages are ignored", () => {
    const payload = makePayload([{ name: "Temperature", value: 0 }]);

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
    const messageTs = new Date("2026-01-15T09:00:00.000Z");
    const payload = makePayload(
      [{ name: "Temperature", value: 75.0 }],
      payloadTs.getTime(),
    );

    const output = flow.onMessage(
      { time: messageTs, topic: "spBv1.0/g/DDATA/n/d", payload },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(1);
    const [measurement] = JSON.parse(output[0].payload as string);
    expect(measurement.payload.time).toBe("2026-01-15T08:30:00.000Z");
  });

  test("output payload is a JSON array with one measurement object", () => {
    const payload = makePayload([{ name: "Temperature", value: 50.0 }]);

    const output = flow.onMessage(
      {
        time: new Date(),
        topic: "spBv1.0/g/DDATA/n/d",
        payload,
      },
      tedge.createContext({}),
    );

    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0].payload as string);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });
});
