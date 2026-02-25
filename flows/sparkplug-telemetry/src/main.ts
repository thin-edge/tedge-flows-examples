import { Message, Context } from "../../common/tedge";
import { fromBinary } from "@bufbuild/protobuf";
import { PayloadSchema, type Payload_Metric } from "./gen/sparkplug_b_pb";

export interface Config {
  debug?: boolean;
}

export interface FlowContext extends Context {
  config: Config;
}

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

// Extract the scalar value from a Sparkplug B metric, returning null for
// complex types (Dataset, Template, Bytes) that cannot be mapped to a
// thin-edge.io measurement value.
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
      // convert boolean to 1/0 as measurements don't allow for boolean values
      return v.value ? 1 : 0;
    // case "stringValue":
    //   return v.value;
    default:
      return null;
  }
}

export function onMessage(message: Message, context: FlowContext): Message[] {
  const topic = parseSparkplugTopic(message.topic);
  if (!topic) return [];

  const { messageType, edgeNodeId, deviceId } = topic;

  // Process data and birth messages; ignore DEATH and CMD messages.
  if (
    messageType !== "DDATA" &&
    messageType !== "NDATA" &&
    messageType !== "DBIRTH" &&
    messageType !== "NBIRTH"
  ) {
    return [];
  }

  // Decode the binary Sparkplug B protobuf payload.
  let spPayload;
  try {
    const bytes =
      typeof message.payload === "string"
        ? new TextEncoder().encode(message.payload)
        : (message.payload as Uint8Array);
    spPayload = fromBinary(PayloadSchema, bytes);
  } catch (e) {
    if (context.config.debug) {
      console.error("Failed to decode Sparkplug B payload:", e);
    }
    return [];
  }

  // DDATA/DBIRTH → use the device ID; NDATA/NBIRTH → use the edge node ID.
  const tedgeDeviceId = messageType.startsWith("D")
    ? (deviceId ?? edgeNodeId)
    : edgeNodeId;

  // Prefer the payload-level timestamp (ms since epoch); fall back to the
  // MQTT message receive time.
  const timestamp =
    spPayload.timestamp !== BigInt(0)
      ? new Date(Number(spPayload.timestamp))
      : message.time;

  // Build a flat thin-edge.io measurement object from all scalar metrics.
  const measurements: Record<string, number | boolean | string> = {
    time: timestamp.toISOString(),
  };

  let hasValues = false;
  for (const metric of spPayload.metrics) {
    if (!metric.name) continue;
    const value = extractMetricValue(metric);
    if (value === null) continue;
    measurements[metric.name] = value;
    hasValues = true;
  }

  if (!hasValues) return [];

  return [
    {
      time: timestamp,
      topic: `te/device/${tedgeDeviceId}///m/`,
      payload: JSON.stringify(measurements),
    },
  ];
}
