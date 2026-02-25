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

export interface FlowContext extends Context {
  config: Config;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type MetricValue = ReturnType<
  typeof create<typeof Payload_MetricSchema>
>["value"];

type TypedMetric = {
  name: string;
  datatype: number;
  value: MetricValue;
};

/**
 * Per-metric registry entry stored in flow state.
 * Aliases are assigned at BIRTH time and reused in every subsequent DATA message.
 * lastValue is stored as a JSON-serializable primitive so complete re-BIRTH
 * messages can include all declared metrics, not just incoming ones.
 */
interface MetricMeta {
  alias: number;
  datatype: number;
  lastValue?: string | number | boolean;
}

// ── Flow state helpers ────────────────────────────────────────────────────────

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

function saveDeviceRegistry(
  context: FlowContext,
  deviceId: string,
  registry: Record<string, MetricMeta>,
): void {
  context.flow.set(`alias:${deviceId}`, JSON.stringify(registry));
  const highest =
    Object.values(registry).reduce((max, m) => Math.max(max, m.alias), -1) + 1;
  context.flow.set(`nextAlias:${deviceId}`, highest);
}

function getNextAlias(context: FlowContext, deviceId: string): number {
  return (context.flow.get(`nextAlias:${deviceId}`) as number | undefined) ?? 0;
}

function nextSeq(context: FlowContext): bigint {
  const prev = (context.flow.get("seq") as number | undefined) ?? -1;
  const seq = (prev + 1) % 256;
  context.flow.set("seq", seq);
  return BigInt(seq);
}

// ── Topic parsing ─────────────────────────────────────────────────────────────

type TedgeChannel = "m" | "e" | "a";

type ParsedTopic = {
  deviceId: string;
  channel: TedgeChannel;
  subtype: string;
};

/**
 * Parse any thin-edge.io entity topic.
 * Format: te/device/{id}///{channel}/{subtype?}
 */
function parseTedgeTopic(topic: string): ParsedTopic | null {
  const parts = topic.split("/");
  // ["te", "device", "{id}", "", "", "{channel}", "{subtype?}"]
  if (parts.length < 6 || parts[0] !== "te" || parts[1] !== "device") {
    return null;
  }
  const channel = parts[5];
  if (channel !== "m" && channel !== "e" && channel !== "a") return null;
  return { deviceId: parts[2], channel, subtype: parts[6] ?? "" };
}

// ── Value conversion helpers ──────────────────────────────────────────────────

function classifyValue(rawValue: unknown): TypedMetric | null {
  if (typeof rawValue === "number") {
    return {
      name: "",
      datatype: DataType.Double,
      value: { case: "doubleValue" as const, value: rawValue },
    };
  } else if (typeof rawValue === "boolean") {
    return {
      name: "",
      datatype: DataType.Boolean,
      value: { case: "booleanValue" as const, value: rawValue },
    };
  } else if (typeof rawValue === "string") {
    return {
      name: "",
      datatype: DataType.String,
      value: { case: "stringValue" as const, value: rawValue },
    };
  }
  return null;
}

/** Extract a JSON-serializable primitive from a protobuf metric value for registry storage. */
function extractPrimitive(
  v: MetricValue,
): string | number | boolean | undefined {
  if (
    v.case === "doubleValue" ||
    v.case === "booleanValue" ||
    v.case === "stringValue"
  ) {
    return v.value as string | number | boolean;
  }
  return undefined;
}

/** Reconstruct a protobuf metric value from a stored primitive + datatype. */
function primitiveToValue(
  v: string | number | boolean,
  datatype: number,
): MetricValue {
  if (datatype === DataType.Boolean)
    return { case: "booleanValue" as const, value: v as boolean };
  if (datatype === DataType.Double)
    return { case: "doubleValue" as const, value: v as number };
  return { case: "stringValue" as const, value: String(v) };
}

// ── Core message builder ──────────────────────────────────────────────────────

/**
 * Shared logic for producing Sparkplug B BIRTH + DATA messages.
 *
 * BIRTH is emitted (retained) when either:
 *   - this is the first message from the device (registry is empty), or
 *   - a metric name not previously seen appears in incoming.
 *
 * Re-issued BIRTH always contains ALL metrics in the device registry so that
 * a host application joining late receives the complete schema from the retained
 * message. Metrics not present in incoming use their last-known stored value;
 * brand-new metrics that have never had a value are declared with isNull=true.
 *
 * DATA carries alias-only metrics (no names on the wire) — Report by Exception.
 */
function buildSparkplugMessages(
  context: FlowContext,
  groupId: string,
  edgeNodeId: string,
  deviceId: string,
  timestamp: Date,
  incoming: TypedMetric[],
): Message[] {
  if (incoming.length === 0) return [];

  const timestampMs = BigInt(timestamp.getTime());
  const isEdgeNode = deviceId === edgeNodeId;

  let registry = getDeviceRegistry(context, deviceId);
  let needsBirth = Object.keys(registry).length === 0;
  let nextAlias = getNextAlias(context, deviceId);

  // Register new metrics and update last-known values.
  for (const metric of incoming) {
    if (!(metric.name in registry)) {
      registry[metric.name] = { alias: nextAlias++, datatype: metric.datatype };
      needsBirth = true;
    }
    registry[metric.name].lastValue = extractPrimitive(metric.value);
  }

  // Always persist updated lastValues so re-BIRTH after a DATA-only update
  // (e.g. alarm clear) reflects the current state.
  saveDeviceRegistry(context, deviceId, registry);

  // Topic construction
  const birthCmd = isEdgeNode ? "NBIRTH" : "DBIRTH";
  const dataCmd = isEdgeNode ? "NDATA" : "DDATA";
  const birthTopic = isEdgeNode
    ? `spBv1.0/${groupId}/${birthCmd}/${edgeNodeId}`
    : `spBv1.0/${groupId}/${birthCmd}/${edgeNodeId}/${deviceId}`;
  const dataTopic = isEdgeNode
    ? `spBv1.0/${groupId}/${dataCmd}/${edgeNodeId}`
    : `spBv1.0/${groupId}/${dataCmd}/${edgeNodeId}/${deviceId}`;

  const incomingByName = new Map(incoming.map((m) => [m.name, m]));
  const output: Message[] = [];

  // ── BIRTH ─────────────────────────────────────────────────────────────────
  if (needsBirth) {
    // Include every metric in the registry so the BIRTH is a complete schema
    // declaration, not just the metrics present in this particular message.
    const birthMetrics = Object.entries(registry).map(([name, meta]) => {
      const current = incomingByName.get(name);
      if (current) {
        // New or updated metric — use the live value.
        return create(Payload_MetricSchema, {
          name,
          alias: BigInt(meta.alias),
          timestamp: timestampMs,
          datatype: meta.datatype,
          value: current.value,
        });
      } else if (meta.lastValue !== undefined) {
        // Previously seen metric — replay last known value.
        return create(Payload_MetricSchema, {
          name,
          alias: BigInt(meta.alias),
          timestamp: timestampMs,
          datatype: meta.datatype,
          value: primitiveToValue(meta.lastValue, meta.datatype),
        });
      } else {
        // Declared but never had a value (shouldn't occur in practice).
        return create(Payload_MetricSchema, {
          name,
          alias: BigInt(meta.alias),
          timestamp: timestampMs,
          datatype: meta.datatype,
          isNull: true,
        });
      }
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

  // ── DATA ──────────────────────────────────────────────────────────────────
  // RbE: only the metrics that changed are included in DATA. Each carries its
  // alias only — no name is transmitted after BIRTH.
  const dataMetrics = incoming.map((m) => {
    const { alias, datatype } = registry[m.name];
    return create(Payload_MetricSchema, {
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

// ── Per-channel handlers ──────────────────────────────────────────────────────

/**
 * Measurements: each key in the JSON payload (excluding "time") becomes a
 * metric with the same name, preserving its native datatype (Double / Boolean / String).
 *
 * Topic: te/device/{id}///m/{measurementType?}
 */
function handleMeasurement(
  _message: Message,
  _context: FlowContext,
  _deviceId: string,
  tedgePayload: Record<string, unknown>,
): TypedMetric[] {
  const metrics: TypedMetric[] = [];
  for (const [key, rawValue] of Object.entries(tedgePayload)) {
    if (key === "time") continue;
    const typed = classifyValue(rawValue);
    if (!typed) continue;
    metrics.push({ ...typed, name: key });
  }
  return metrics;
}

/**
 * Events: the event text becomes a single String metric named `Event/{type}`.
 *
 * RbE: a DDATA is only published when an event fires. Events are ephemeral
 * (fire-and-forget), so there is no "clear" concept — the last emitted BIRTH
 * value is whatever the previous event text was.
 *
 * Topic: te/device/{id}///e/{eventType}
 */
function handleEvent(
  _message: Message,
  _context: FlowContext,
  _deviceId: string,
  eventType: string,
  tedgePayload: Record<string, unknown>,
): TypedMetric[] {
  const text =
    typeof tedgePayload["text"] === "string" ? tedgePayload["text"] : "";
  return [
    {
      name: `Event/${eventType || "default"}`,
      datatype: DataType.String,
      value: { case: "stringValue" as const, value: text },
    },
  ];
}

/**
 * Alarms: modelled as two metrics per alarm type:
 *   Alarm/{type}/Active  — Boolean  (true = raised, false = cleared)
 *   Alarm/{type}/Text    — String   (alarm message; empty string when cleared)
 *
 * RbE: a DDATA is only published when the alarm state changes — either the
 * thin-edge.io runtime raising it (payload with "text") or clearing it
 * (empty payload {}).
 *
 * Topic: te/device/{id}///a/{alarmType}
 */
function handleAlarm(
  _message: Message,
  _context: FlowContext,
  _deviceId: string,
  alarmType: string,
  tedgePayload: Record<string, unknown>,
): TypedMetric[] {
  const text =
    typeof tedgePayload["text"] === "string" ? tedgePayload["text"] : "";
  const active = text.length > 0;
  const prefix = `Alarm/${alarmType || "default"}`;
  return [
    {
      name: `${prefix}/Active`,
      datatype: DataType.Boolean,
      value: { case: "booleanValue" as const, value: active },
    },
    {
      name: `${prefix}/Text`,
      datatype: DataType.String,
      value: { case: "stringValue" as const, value: text },
    },
  ];
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function onMessage(message: Message, context: FlowContext): Message[] {
  const { groupId, edgeNodeId, debug = false } = context.config;
  if (!groupId || !edgeNodeId) {
    if (debug)
      console.error(
        "sparkplug-publisher: groupId and edgeNodeId must be configured",
      );
    return [];
  }

  const parsed = parseTedgeTopic(message.topic);
  if (!parsed) return [];

  const { deviceId, channel, subtype } = parsed;

  // thin-edge.io clears alarms by publishing an empty retained message (''),
  // which is not valid JSON. Treat any empty payload on an alarm topic as a
  // clear signal (equivalent to { text: "" }).
  const rawPayload =
    typeof message.payload === "string"
      ? message.payload
      : new TextDecoder().decode(message.payload);
  const isEmpty = rawPayload.trim() === "";

  if (isEmpty && channel !== "a") return [];

  let tedgePayload: Record<string, unknown>;
  if (isEmpty) {
    tedgePayload = {}; // alarm clear
  } else {
    try {
      tedgePayload = decodeJsonPayload(message.payload);
    } catch (e) {
      if (debug)
        console.error("sparkplug-publisher: failed to parse JSON payload", e);
      return [];
    }
  }

  // Resolve timestamp from payload "time" field, fall back to message receive time.
  const timeField = tedgePayload["time"];
  const timestamp =
    typeof timeField === "string" ? new Date(timeField) : message.time;

  let incoming: TypedMetric[];
  if (channel === "m") {
    incoming = handleMeasurement(message, context, deviceId, tedgePayload);
  } else if (channel === "e") {
    incoming = handleEvent(message, context, deviceId, subtype, tedgePayload);
  } else if (channel === "a") {
    incoming = handleAlarm(message, context, deviceId, subtype, tedgePayload);
  } else {
    return [];
  }

  return buildSparkplugMessages(
    context,
    groupId,
    edgeNodeId,
    deviceId,
    timestamp,
    incoming,
  );
}
