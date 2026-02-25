import { Message, Context, decodeJsonPayload } from "../../common/tedge";
import { create, toBinary } from "@bufbuild/protobuf";
import { PayloadSchema, Payload_MetricSchema } from "./gen/sparkplug_b_pb";

// Sparkplug B datatype constants
const DataType = {
  Double: 10,
  Boolean: 11,
  String: 12,
} as const;

export interface Config {
  /** Sparkplug B Group ID - required */
  groupId: string;
  /** Sparkplug B Edge Node ID - required */
  edgeNodeId: string;
  debug?: boolean;
}

/**
 * Per-metric alias record stored in flow state.
 * Aliases are assigned at BIRTH time and reused in every subsequent DATA message,
 * saving the full metric name string from being retransmitted on the wire.
 */
interface MetricMeta {
  alias: number;
  datatype: number;
}

/** Load the alias registry for a device from persistent flow state. */
function getDeviceRegistry(
  context: FlowContext,
  deviceId: string,
): Record<string, MetricMeta> {
  const raw = context.flow.get(`alias:${deviceId}`) as string | undefined;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, MetricMeta>;
  } catch {
    return {};
  }
}

/** Save the alias registry for a device back to flow state. */
function saveDeviceRegistry(
  context: FlowContext,
  deviceId: string,
  registry: Record<string, MetricMeta>,
): void {
  context.flow.set(`alias:${deviceId}`, JSON.stringify(registry));
  // Track the next free alias number alongside the registry.
  const highest =
    Object.values(registry).reduce((max, m) => Math.max(max, m.alias), -1) + 1;
  context.flow.set(`nextAlias:${deviceId}`, highest);
}

/** Return the next free alias integer for a device. */
function getNextAlias(context: FlowContext, deviceId: string): number {
  return (context.flow.get(`nextAlias:${deviceId}`) as number | undefined) ?? 0;
}

export interface FlowContext extends Context {
  config: Config;
}

// thin-edge.io measurement topic: te/device/{name}///m/{type}
// Returns null if the topic does not match.
function parseTedgeMeasurementTopic(
  topic: string,
): { deviceId: string; measurementType: string } | null {
  const parts = topic.split("/");
  // Expected: ["te", "device", "{name}", "", "", "m", "{type?}"]
  if (parts.length < 6 || parts[0] !== "te" || parts[5] !== "m") {
    return null;
  }
  return {
    deviceId: parts[2],
    measurementType: parts[6] ?? "",
  };
}

/** Classify a raw payload value into a Sparkplug B typed metric value + datatype. */
function classifyValue(rawValue: unknown): {
  value: ReturnType<typeof create<typeof Payload_MetricSchema>>["value"];
  datatype: number;
} | null {
  if (typeof rawValue === "number") {
    return {
      value: { case: "doubleValue" as const, value: rawValue },
      datatype: DataType.Double,
    };
  } else if (typeof rawValue === "boolean") {
    return {
      value: { case: "booleanValue" as const, value: rawValue },
      datatype: DataType.Boolean,
    };
  } else if (typeof rawValue === "string") {
    return {
      value: { case: "stringValue" as const, value: rawValue },
      datatype: DataType.String,
    };
  }
  // Skip complex types (objects, arrays) that have no direct Sparkplug B scalar mapping.
  return null;
}

/** Advance the rolling 0-255 Sparkplug B sequence number and return it. */
function nextSeq(context: FlowContext): bigint {
  const prev = (context.flow.get("seq") as number | undefined) ?? -1;
  const seq = (prev + 1) % 256;
  context.flow.set("seq", seq);
  return BigInt(seq);
}

export function onMessage(message: Message, context: FlowContext): Message[] {
  const { groupId, edgeNodeId, debug = false } = context.config;
  if (!groupId || !edgeNodeId) {
    if (debug)
      console.error(
        "sparkplug-publisher: groupId and edgeNodeId must be configured",
      );
    return [];
  }

  const parsed = parseTedgeMeasurementTopic(message.topic);
  if (!parsed) return [];

  const { deviceId } = parsed;

  let tedgePayload: Record<string, unknown>;
  try {
    tedgePayload = decodeJsonPayload(message.payload);
  } catch (e) {
    if (debug)
      console.error("sparkplug-publisher: failed to parse JSON payload", e);
    return [];
  }

  // Resolve the measurement timestamp; fall back to message receive time.
  const timeField = tedgePayload["time"];
  const timestamp =
    typeof timeField === "string" ? new Date(timeField) : message.time;
  const timestampMs = BigInt(timestamp.getTime());

  // Classify each incoming metric value (skip "time" and complex types).
  type TypedMetric = {
    name: string;
    datatype: number;
    value: ReturnType<typeof create<typeof Payload_MetricSchema>>["value"];
  };
  const incoming: TypedMetric[] = [];
  for (const [key, rawValue] of Object.entries(tedgePayload)) {
    if (key === "time") continue;
    const typed = classifyValue(rawValue);
    if (!typed) continue;
    incoming.push({ name: key, ...typed });
  }

  if (incoming.length === 0) return [];

  // ── Alias registry ────────────────────────────────────────────────────────
  // Each device's metric names are mapped to stable integer aliases once in a
  // BIRTH message. Subsequent DATA messages carry only the alias, not the name,
  // saving bandwidth on every measurement update.
  let registry = getDeviceRegistry(context, deviceId);
  let needsBirth = Object.keys(registry).length === 0; // first time we see this device
  let nextAlias = getNextAlias(context, deviceId);

  for (const metric of incoming) {
    if (!(metric.name in registry)) {
      registry[metric.name] = { alias: nextAlias++, datatype: metric.datatype };
      needsBirth = true; // new metric appeared → must re-issue BIRTH
    }
  }

  if (needsBirth) {
    saveDeviceRegistry(context, deviceId, registry);
  }

  // ── Topic construction ────────────────────────────────────────────────────
  const isEdgeNode = deviceId === edgeNodeId;
  const birthCmd = isEdgeNode ? "NBIRTH" : "DBIRTH";
  const dataCmd = isEdgeNode ? "NDATA" : "DDATA";
  const birthTopic = isEdgeNode
    ? `spBv1.0/${groupId}/${birthCmd}/${edgeNodeId}`
    : `spBv1.0/${groupId}/${birthCmd}/${edgeNodeId}/${deviceId}`;
  const dataTopic = isEdgeNode
    ? `spBv1.0/${groupId}/${dataCmd}/${edgeNodeId}`
    : `spBv1.0/${groupId}/${dataCmd}/${edgeNodeId}/${deviceId}`;

  const output: Message[] = [];

  // ── BIRTH message (retained, full names + aliases, current values) ────────
  // The Sparkplug B spec requires BIRTH to be published as a retained MQTT
  // message so that any host application joining later can reconstruct the
  // alias→name mapping without waiting for the next DATA.
  //
  // Note: NDEATH should be configured as the MQTT Will with the bdSeq counter
  // at connection time — that happens outside the flow (in the MQTT client
  // configuration), not here.
  if (needsBirth) {
    const birthMetrics = incoming.map((m) => {
      const { alias, datatype } = registry[m.name];
      return create(Payload_MetricSchema, {
        name: m.name, // full name only in BIRTH
        alias: BigInt(alias), // alias defined here, reused in all DATA
        timestamp: timestampMs,
        datatype,
        value: m.value,
      });
    });

    output.push({
      time: timestamp,
      topic: birthTopic,
      payload: toBinary(
        PayloadSchema,
        create(PayloadSchema, {
          timestamp: timestampMs,
          seq: nextSeq(context),
          metrics: birthMetrics,
        }),
      ),
      mqtt: { retain: true, qos: 1 },
    });
  }

  // ── DATA message (alias only — no metric names on the wire) ───────────────
  const dataMetrics = incoming.map((m) => {
    const { alias, datatype } = registry[m.name];
    return create(Payload_MetricSchema, {
      // name intentionally omitted — consumers resolve via the BIRTH alias map
      alias: BigInt(alias),
      timestamp: timestampMs,
      datatype,
      value: m.value,
    });
  });

  output.push({
    time: timestamp,
    topic: dataTopic,
    payload: toBinary(
      PayloadSchema,
      create(PayloadSchema, {
        timestamp: timestampMs,
        seq: nextSeq(context),
        metrics: dataMetrics,
      }),
    ),
  });

  return output;
}
