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

  // Convert each measurement field (excluding "time") to a Sparkplug B Metric.
  const metrics = [];
  for (const [key, rawValue] of Object.entries(tedgePayload)) {
    if (key === "time") continue;

    let value: ReturnType<typeof create<typeof Payload_MetricSchema>>["value"];
    let datatype: number;

    if (typeof rawValue === "number") {
      value = { case: "doubleValue" as const, value: rawValue };
      datatype = DataType.Double;
    } else if (typeof rawValue === "boolean") {
      value = { case: "booleanValue" as const, value: rawValue };
      datatype = DataType.Boolean;
    } else if (typeof rawValue === "string") {
      value = { case: "stringValue" as const, value: rawValue };
      datatype = DataType.String;
    } else {
      // Skip complex types (objects, arrays) that have no direct Sparkplug B scalar mapping.
      continue;
    }

    metrics.push(
      create(Payload_MetricSchema, {
        name: key,
        timestamp: timestampMs,
        datatype,
        value,
      }),
    );
  }

  if (metrics.length === 0) return [];

  // Maintain a rolling 0-255 Sparkplug B sequence number in flow state.
  const prevSeq: number = context.flow.get("seq") ?? -1;
  const seq = (prevSeq + 1) % 256;
  context.flow.set("seq", seq);

  const spPayload = create(PayloadSchema, {
    timestamp: timestampMs,
    seq: BigInt(seq),
    metrics,
  });

  const binaryPayload = toBinary(PayloadSchema, spPayload);

  // DDATA for child devices; NDATA when the device IS the edge node.
  const isEdgeNode = deviceId === edgeNodeId;
  const spTopic = isEdgeNode
    ? `spBv1.0/${groupId}/NDATA/${edgeNodeId}`
    : `spBv1.0/${groupId}/DDATA/${edgeNodeId}/${deviceId}`;

  return [
    {
      time: timestamp,
      topic: spTopic,
      payload: binaryPayload,
    },
  ];
}
