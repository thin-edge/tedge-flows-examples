import { fromBinary } from "@bufbuild/protobuf";
import {
  PayloadSchema,
  type Payload_Metric,
} from "../../sparkplug-telemetry/src/gen/sparkplug_b_pb";

interface DeviceMessage {
  time: Date;
  topic: string;
  payload: Uint8Array<ArrayBufferLike>;
}

interface CumulocityMessage {
  cumulocityType: "measurement" | "event" | "alarm" | "inventory";
  externalSource?: Array<{ externalId: string; type: string }>;
  payload: Uint8Array<ArrayBufferLike> | string;
}

// Extract the numeric value from a Sparkplug B metric.
// Returns null for non-numeric or null metrics.
function extractNumericValue(metric: Payload_Metric): number | null {
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
    default:
      return null;
  }
}

export function onMessage(
  message: DeviceMessage,
  context: any,
): CumulocityMessage[] {
  // FIXME: replace with external id and read it from the topic
  const sourceId = "7052741116";

  // Decode the binary Sparkplug B protobuf payload.
  let spPayload;
  try {
    spPayload = fromBinary(PayloadSchema, message.payload);
  } catch (e) {
    console.error("Failed to decode Sparkplug B payload:", e);
    return [];
  }

  console.debug(
    `Received sparkplugB message. seq=${spPayload.seq}, metricCount=${spPayload.metrics.length}, timestamp=${spPayload.timestamp}`,
  );

  // Prefer the payload-level timestamp (ms since epoch); fall back to the
  // MQTT message receive time.
  let timestamp;

  try {
    timestamp =
      spPayload.timestamp !== BigInt(0)
        ? new Date(Number(spPayload.timestamp))
        : message.time;
  } catch (err) {
    console.log(`Failed to get timestamp. err=${err}`);
    timestamp = message.time;
  }

  const payload: any = {
    time: timestamp,
    // Fallback until externalId resolution is fully supported.
    source: { id: sourceId },
    type: "c8y_SparkPlugB",
  };

  spPayload.metrics.forEach((metric) => {
    try {
      const [fragment, ...series] = metric.name.split(".");
      const seriesName = series.join("_") || fragment;
      const value = extractNumericValue(metric);
      if (value !== null) {
        payload[fragment] = {
          ...(payload[fragment] || {}),
          [seriesName]: {
            value,
          },
        };
      }
    } catch (err) {
      console.error(`Could not parse series or value. err=${err}`);
    }
  });

  return [
    {
      cumulocityType: "measurement",
      externalSource: [{ externalId: message?.clientID, type: "c8y_Serial" }], // for once external Id is working
      payload,
    },
  ];
}
