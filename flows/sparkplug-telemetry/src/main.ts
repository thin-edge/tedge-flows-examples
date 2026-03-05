import { Message, Context } from "../../common/tedge";
import { fromBinary, create, toBinary } from "@bufbuild/protobuf";
import { PayloadSchema, Payload_MetricSchema, type Payload, type Payload_Metric } from "./gen/sparkplug_b_pb";

export interface Config {
  debug?: boolean;
}

export interface FlowContext extends Context {
  config: Config;
}

// ── Topic parsing ─────────────────────────────────────────────────────────────

// Sparkplug B topic structure: spBv1.0/{group_id}/{message_type}/{edge_node_id}[/{device_id}]
interface SparkplugTopic {
  groupId: string;
  messageType: string;
  edgeNodeId: string;
  deviceId?: string;
}

function parseSparkplugTopic(topic: string): SparkplugTopic | null {
  const parts = topic.split("/");
  if (parts.length < 4 || parts[0] !== "spBv1.0") {
    return null;
  }
  return {
    groupId: parts[1],
    messageType: parts[2],
    edgeNodeId: parts[3],
    deviceId: parts[4],
  };
}

// ── Alias registry ────────────────────────────────────────────────────────────
//
// BIRTH messages carry both a metric name and a numeric alias.  Every
// subsequent DATA message omits the name and uses only the alias to keep
// payloads compact (Report-by-Exception).  We maintain a per-device
// alias → name map in flow state so DATA metrics can be resolved.

function getAliasRegistry(
  context: FlowContext,
  deviceId: string,
): Map<string, string> {
  const raw = context.flow.get(`aliasMap:${deviceId}`) as string | undefined;
  if (!raw) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(raw) as Record<string, string>));
  } catch {
    return new Map();
  }
}

function saveAliasRegistry(
  context: FlowContext,
  deviceId: string,
  registry: Map<string, string>,
): void {
  context.flow.set(
    `aliasMap:${deviceId}`,
    JSON.stringify(Object.fromEntries(registry)),
  );
}

/**
 * Update the alias registry from a BIRTH payload.
 * Any metric that carries a non-empty name registers the alias→name mapping.
 * Returns the updated registry (ready for immediate use in the same call).
 */
function updateAliasRegistry(
  context: FlowContext,
  deviceId: string,
  metrics: Payload_Metric[],
): Map<string, string> {
  const registry = getAliasRegistry(context, deviceId);
  for (const metric of metrics) {
    if (metric.name) {
      registry.set(String(metric.alias), metric.name);
    }
  }
  saveAliasRegistry(context, deviceId, registry);
  return registry;
}

// ── Metric value extraction ───────────────────────────────────────────────────

// Extract the scalar value from a Sparkplug B metric.
// Returns null for complex types (DataSet, Template, Bytes) that have no
// direct thin-edge.io equivalent.
function extractMetricValue(
  metric: Payload_Metric,
): number | boolean | string | null {
  if (metric.isNull) return null;
  const v = metric.value;
  switch (v.case) {
    case "intValue":
      return v.value;
    case "longValue":
      // bigint → number; precision loss only above Number.MAX_SAFE_INTEGER
      return Number(v.value);
    case "floatValue":
      return v.value;
    case "doubleValue":
      return v.value;
    case "booleanValue":
      return v.value;
    case "stringValue":
      return v.value;
    default:
      return null;
  }
}

// ── Resolved metric ───────────────────────────────────────────────────────────

interface ResolvedMetric {
  name: string;
  value: number | boolean | string | null;
}

/**
 * Resolve the name for each metric in a payload.
 *
 * - If the metric already carries a non-empty name (BIRTH or disableAliases
 *   mode) use it directly.
 * - Otherwise look up the alias in the provided registry (DATA mode).
 * - Metrics whose name cannot be resolved are silently dropped.
 */
function resolveMetrics(
  metrics: Payload_Metric[],
  registry: Map<string, string>,
): ResolvedMetric[] {
  const resolved: ResolvedMetric[] = [];
  for (const metric of metrics) {
    const name =
      metric.name !== ""
        ? metric.name
        : (registry.get(String(metric.alias)) ?? "");
    if (!name) continue; // alias unknown — cannot process

    const value = extractMetricValue(metric);
    if (value === null) continue; // null/complex metric — skip

    resolved.push({ name, value });
  }
  return resolved;
}

// ── Metric classification ─────────────────────────────────────────────────────
//
// Metric naming convention (mirrors sparkplug-publisher):
//   Event/{eventType}          → thin-edge.io event
//   Alarm/{alarmType}/Active   → alarm active flag    (Boolean)
//   Alarm/{alarmType}/Text     → alarm text message   (String)
//   (anything else)            → thin-edge.io measurement

interface MetricGroups {
  measurements: ResolvedMetric[];
  events: ResolvedMetric[];        // name = "Event/{type}"
  booleanMetrics: ResolvedMetric[]; // boolean-valued plain metrics → events with RbE
  alarmParts: ResolvedMetric[];    // name = "Alarm/{type}/Active|Text"
}

function classifyMetrics(metrics: ResolvedMetric[]): MetricGroups {
  const measurements: ResolvedMetric[] = [];
  const events: ResolvedMetric[] = [];
  const booleanMetrics: ResolvedMetric[] = [];
  const alarmParts: ResolvedMetric[] = [];

  for (const metric of metrics) {
    if (metric.name.startsWith("Event/")) {
      events.push(metric);
    } else if (metric.name.startsWith("Alarm/")) {
      alarmParts.push(metric);
    } else if (typeof metric.value === "boolean") {
      // Boolean metrics are treated as state-change events, not measurements.
      booleanMetrics.push(metric);
    } else {
      measurements.push(metric);
    }
  }
  return { measurements, events, booleanMetrics, alarmParts };
}

// ── Output builders ───────────────────────────────────────────────────────────
//
// Metric names follow a dot-notation convention: <group>[.<series>[.<unit>]]
// Cumulocity IoT forbids dots in measurement names, so we parse them into a
// two-level nested structure:
//
//   1 part  → flat scalar:        { "name": value }
//   2 parts → nested, no unit:    { "group": { "series": value } }
//   3 parts → nested with unit:   { "group": { "series": value } }  unit = parts[2]
//   4+ parts → nested, collapsed: { "group": { "series1_series2": value } }  unit = last part
//
// Unit information is published separately as a retained meta message on BIRTH.

interface NestedKey {
  group: string;
  series?: string; // undefined for flat (1-part) metrics
  unit?: string;   // present when name has 3+ parts
}

function nestMetricName(name: string): NestedKey {
  const parts = name.split(".");
  if (parts.length === 1) return { group: parts[0] };
  if (parts.length === 2) return { group: parts[0], series: parts[1] };
  // 3+ parts: group=first, unit=last, series=middle joined with "_"
  return {
    group: parts[0],
    series: parts.slice(1, parts.length - 1).join("_"),
    unit: normalizeUnit(parts[parts.length - 1]),
  };
}

// Map common unit strings (as they typically appear in metric names) to their
// standard SI / widely-accepted symbols.
const UNIT_MAP: Record<string, string> = {
  celsius:          "°C",
  fahrenheit:       "°F",
  kelvin:           "K",
  pct:              "%",
  percent:          "%",
  rpm:              "r/min",
  mm:               "mm",
  cm:               "cm",
  m:                "m",
  km:               "km",
  mm_per_min:       "mm/min",
  m_per_s:          "m/s",
  km_per_h:         "km/h",
  bar:              "bar",
  kpa:              "kPa",
  pa:               "Pa",
  mbar:             "mbar",
  psi:              "psi",
  w:                "W",
  kw:               "kW",
  mw:               "MW",
  kwh:              "kWh",
  v:                "V",
  mv:               "mV",
  a:                "A",
  ma:               "mA",
  hz:               "Hz",
  khz:              "kHz",
  mhz:              "MHz",
  ohm:              "Ω",
  s:                "s",
  ms:               "ms",
  us:               "µs",
  min:              "min",
  h:                "h",
  litres_per_min:   "L/min",
  l_per_min:        "L/min",
  ml_per_min:       "mL/min",
  litres_per_h:     "L/h",
  l:                "L",
  ml:               "mL",
  kg:               "kg",
  g:                "g",
  mg:               "mg",
  n:                "N",
  nm:               "N·m",
  lux:              "lx",
  db:               "dB",
  dba:              "dB(A)",
  ppm:              "ppm",
  ppb:              "ppb",
  ug_per_m3:        "µg/m³",
  mg_per_m3:        "mg/m³",
};

function normalizeUnit(raw: string): string {
  return UNIT_MAP[raw.toLowerCase()] ?? raw;
}

function buildMeasurement(
  deviceId: string,
  timestamp: Date,
  metrics: ResolvedMetric[],
): Message | null {
  const body: Record<string, unknown> = { time: timestamp.toISOString() };
  let hasValues = false;
  for (const m of metrics) {
    if (typeof m.value !== "number") continue;
    const { group, series } = nestMetricName(m.name);
    if (series === undefined) {
      // Flat scalar (1-part name)
      body[group] = m.value;
    } else {
      if (typeof body[group] !== "object" || body[group] === null) body[group] = {};
      (body[group] as Record<string, number>)[series] = m.value;
    }
    hasValues = true;
  }
  if (!hasValues) return null;
  return {
    time: timestamp,
    topic: `te/device/${deviceId}///m/`,
    payload: JSON.stringify(body),
  };
}

// Publish unit metadata for all measurement metrics that carry unit information
// (3+ part names).  Published retained to te/device/{id}///m//meta on BIRTH so
// downstream consumers (e.g. thin-edge.io → Cumulocity) know the unit per series.
function buildMeasurementMeta(
  deviceId: string,
  metrics: ResolvedMetric[],
): Message | null {
  const meta: Record<string, { unit: string }> = {};
  for (const m of metrics) {
    if (typeof m.value !== "number") continue;
    const { group, series, unit } = nestMetricName(m.name);
    if (!unit || series === undefined) continue;
    meta[`${group}.${series}`] = { unit };
  }
  if (Object.keys(meta).length === 0) return null;
  return {
    time: new Date(),
    topic: `te/device/${deviceId}///m//meta`,
    payload: JSON.stringify(meta),
    mqtt: { retain: true, qos: 1 },
  };
}

function buildEvents(
  deviceId: string,
  timestamp: Date,
  events: ResolvedMetric[],
): Message[] {
  return events.map((m) => {
    // name is "Event/{type}" — strip prefix to get the event type
    const eventType = m.name.slice("Event/".length) || "default";
    const text =
      typeof m.value === "string" ? m.value : String(m.value ?? "");
    return {
      time: timestamp,
      topic: `te/device/${deviceId}///e/${eventType}`,
      payload: JSON.stringify({ text, time: timestamp.toISOString() }),
    };
  });
}

// Boolean-valued plain metrics are emitted as thin-edge.io events with
// Report-by-Exception semantics: only publish when the value changes.
function buildBooleanEvents(
  context: FlowContext,
  deviceId: string,
  timestamp: Date,
  booleanMetrics: ResolvedMetric[],
): Message[] {
  const output: Message[] = [];
  for (const metric of booleanMetrics) {
    const isActive = metric.value as boolean;
    const stateKey = `boolState:${deviceId}:${metric.name}`;
    const wasActive = context.flow.get(stateKey) as boolean | undefined;
    if (wasActive === isActive) continue; // no state change — skip
    context.flow.set(stateKey, isActive);

    // Convert metric name to a valid MQTT path segment (replace "/" with "_")
    const eventType = metric.name.replace(/\//g, "_");
    output.push({
      time: timestamp,
      topic: `te/device/${deviceId}///e/${eventType}`,
      payload: JSON.stringify({
        text: `${metric.name} changed to ${isActive}`,
        time: timestamp.toISOString(),
      }),
    });
  }
  return output;
}

function buildAlarms(
  context: FlowContext,
  deviceId: string,
  timestamp: Date,
  alarmParts: ResolvedMetric[],
): Message[] {
  // Collect Active and Text fields per alarm type
  const alarms = new Map<string, { active?: boolean; text?: string }>();

  for (const part of alarmParts) {
    // name patterns: "Alarm/{type}/Active" or "Alarm/{type}/Text"
    const match = part.name.match(/^Alarm\/(.+?)\/(Active|Text)$/);
    if (!match) continue;
    const [, alarmType, field] = match;
    if (!alarms.has(alarmType)) alarms.set(alarmType, {});
    const entry = alarms.get(alarmType)!;
    if (field === "Active") {
      entry.active =
        typeof part.value === "boolean"
          ? part.value
          : Boolean(part.value);
    } else {
      entry.text =
        typeof part.value === "string" ? part.value : String(part.value ?? "");
    }
  }

  const output: Message[] = [];
  for (const [alarmType, { active, text }] of alarms) {
    // active wins; if only text is present, non-empty text means raised alarm.
    const isActive =
      active !== undefined ? active : (text !== undefined && text.length > 0);

    // Only emit when the alarm state has actually changed (Report-by-Exception).
    // This prevents flooding thin-edge.io with clears for alarms that were
    // already inactive, since the Go simulator sends all metrics on every tick.
    const stateKey = `alarmState:${deviceId}:${alarmType}`;
    const wasActive = context.flow.get(stateKey) as boolean | undefined;
    if (wasActive === isActive) continue; // no state change — skip
    context.flow.set(stateKey, isActive);

    if (isActive) {
      output.push({
        time: timestamp,
        topic: `te/device/${deviceId}///a/${alarmType}`,
        payload: JSON.stringify({ text: text ?? "", time: timestamp.toISOString() }),
      });
    } else {
      // thin-edge.io clears alarms by publishing an empty retained message.
      output.push({
        time: timestamp,
        topic: `te/device/${deviceId}///a/${alarmType}`,
        payload: "",
        mqtt: { retain: true, qos: 1 },
      });
    }
  }
  return output;
}

// ── Rebirth request ───────────────────────────────────────────────────────────
//
// Per the Sparkplug B spec, a Primary Application that receives a DATA message
// without a prior BIRTH (empty alias registry) must request a rebirth by
// publishing NCMD with "Node Control/Rebirth = true" to the edge node.

function buildRebirthCommand(
  groupId: string,
  edgeNodeId: string,
  timestamp: Date,
): Message {
  const payload = toBinary(
    PayloadSchema,
    create(PayloadSchema, {
      timestamp: BigInt(timestamp.getTime()),
      metrics: [
        create(Payload_MetricSchema, {
          name: "Node Control/Rebirth",
          value: { case: "booleanValue", value: true },
        }),
      ],
    }),
  );
  return {
    time: timestamp,
    topic: `spBv1.0/${groupId}/NCMD/${edgeNodeId}`,
    payload,
    mqtt: { qos: 1 },
  };
}

// ── Protobuf decode helpers ───────────────────────────────────────────────────

// WORKAROUND: Some brokers/transports silently drop trailing 0x00 bytes from
// binary payloads, causing fromBinary to throw "premature EOF".
// Retry with up to 8 appended null bytes to recover the missing zeros.
// TODO: Remove once the root cause (broker/transport stripping null bytes) is fixed.
function fromBinaryWithNullPadding(
  schema: typeof PayloadSchema,
  bytes: Uint8Array,
  debug: boolean,
  topic: string,
): Payload {
  let lastErr: unknown;
  for (let pad = 0; pad <= 8; pad++) {
    let buf = bytes;
    if (pad > 0) {
      buf = new Uint8Array(bytes.length + pad);
      buf.set(bytes);
    }
    try {
      const result = fromBinary(schema, buf);
      if (pad > 0 && debug) {
        console.warn(`sparkplug-telemetry: recovered decode after padding ${pad} zero byte(s), topic=${topic}`);
      }
      return result;
    } catch (e) {
      lastErr = e;
      const errMsg = e instanceof Error ? e.message : String(e);
      if (!errMsg.toLowerCase().includes("premature eof")) break;
    }
  }
  throw lastErr;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function onMessage(message: Message, context: FlowContext): Message[] {
  const topic = parseSparkplugTopic(message.topic);
  if (!topic) return [];

  const { groupId, messageType, edgeNodeId, deviceId } = topic;
  const debug = context.config.debug ?? false;

  const isBirth = messageType === "DBIRTH" || messageType === "NBIRTH";
  const isData = messageType === "DDATA" || messageType === "NDATA";

  // Only process BIRTH and DATA messages; ignore DEATH, CMD, and STATE.
  if (!isBirth && !isData) {
    return [];
  }

  // DDATA/DBIRTH → use the device ID; NDATA/NBIRTH → use the edge node ID.
  const tedgeDeviceId = messageType.startsWith("D")
    ? (deviceId ?? edgeNodeId)
    : edgeNodeId;

  // Decode the binary Sparkplug B protobuf payload.
  let spPayload;
  try {
    const raw = message.payload;
    const payloadType = typeof raw;
    const isUint8 = raw instanceof Uint8Array;
    const bytes: Uint8Array =
      typeof raw === "string"
        ? new TextEncoder().encode(raw)
        : (raw as Uint8Array);
    if (debug) {
      const hex = Array.from(bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, "0")).join(" ");
      console.log(`sparkplug-telemetry: payload type=${payloadType} isUint8=${isUint8} byteOffset=${isUint8 ? (raw as Uint8Array).byteOffset : "n/a"} length=${bytes.length} first16=${hex} topic=${message.topic}`);
    }
    spPayload = fromBinaryWithNullPadding(PayloadSchema, bytes, debug, message.topic);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (debug) {
      console.error(`sparkplug-telemetry: failed to decode payload: ${msg}, topic=${message.topic}`);
    }
    throw new Error(`sparkplug-telemetry: failed to decode payload: ${msg}, topic=${message.topic}`);
    return [];
  }

  if (debug) {
    console.log(`sparkplug-telemetry: decoded OK metrics=${spPayload.metrics.length} topic=${message.topic}`);
  }

  // Prefer the payload-level timestamp (ms since epoch); fall back to the
  // MQTT message receive time.
  const timestamp =
    spPayload.timestamp !== BigInt(0)
      ? new Date(Number(spPayload.timestamp))
      : message.time;

  // BIRTH messages carry both name and alias for every metric.  We persist
  // the alias → name mapping so later DATA messages (alias-only) can be decoded.
  // BIRTH itself produces no measurement/event/alarm output (it is a full state
  // snapshot, not a Report-by-Exception delta).  We do publish retained unit
  // metadata so downstream consumers know the unit for each measurement series.
  let aliasRegistry = getAliasRegistry(context, tedgeDeviceId);
  if (isBirth) {
    aliasRegistry = updateAliasRegistry(context, tedgeDeviceId, spPayload.metrics);
    context.flow.set(`rebirthPending:${edgeNodeId}`, false);
    if (debug) {
      console.log(`sparkplug-telemetry: BIRTH registry updated size=${aliasRegistry.size} device=${tedgeDeviceId}`);
    }
    // Publish measurement unit metadata (retained) derived from the BIRTH metric names.
    const resolved = resolveMetrics(spPayload.metrics, aliasRegistry);
    const { measurements } = classifyMetrics(resolved);
    const metaMsg = buildMeasurementMeta(tedgeDeviceId, measurements);
    return metaMsg ? [metaMsg] : [];
  }

  // ── DATA path ─────────────────────────────────────────────────────────────

  if (debug) {
    console.log(`sparkplug-telemetry: DATA registry size=${aliasRegistry.size} device=${tedgeDeviceId}`);
  }

  // Resolve names and values for all metrics in this payload.
  const resolved = resolveMetrics(spPayload.metrics, aliasRegistry);
  if (debug) {
    console.log(`sparkplug-telemetry: resolved=${resolved.length}/${spPayload.metrics.length} topic=${message.topic}`);
  }
  if (resolved.length === 0) {
    // If the metrics are alias-only and there's no registry (no BIRTH seen yet),
    // request a rebirth per the Sparkplug B spec so aliases can be resolved.
    // Only send once per edge node until the BIRTH arrives and clears the flag.
    const hasAliasOnlyMetrics = spPayload.metrics.some(m => !m.name);
    if (aliasRegistry.size === 0 && hasAliasOnlyMetrics) {
      const alreadyPending = Boolean(context.flow.get(`rebirthPending:${edgeNodeId}`));
      if (!alreadyPending) {
        context.flow.set(`rebirthPending:${edgeNodeId}`, true);
        if (debug) {
          console.log(`sparkplug-telemetry: no BIRTH seen — requesting rebirth from ${edgeNodeId}`);
        }
        return [buildRebirthCommand(groupId, edgeNodeId, message.time)];
      }
    }
    return [];
  }

  const { measurements, events, booleanMetrics, alarmParts } = classifyMetrics(resolved);
  const output: Message[] = [];

  // Measurements → te/device/{id}///m/  (nested by group for Cumulocity compatibility)
  const measMsg = buildMeasurement(tedgeDeviceId, timestamp, measurements);
  if (measMsg) output.push(measMsg);

  // Boolean metrics → te/device/{id}///e/{name} (only on state change)
  output.push(...buildBooleanEvents(context, tedgeDeviceId, timestamp, booleanMetrics));

  // Named events → te/device/{id}///e/{type}
  output.push(...buildEvents(tedgeDeviceId, timestamp, events));

  // Alarms → te/device/{id}///a/{type}  (empty payload = clear, only on state change)
  output.push(...buildAlarms(context, tedgeDeviceId, timestamp, alarmParts));

  return output;
}
