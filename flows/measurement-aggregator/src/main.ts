import { Message, Context, decodePayload } from "../../common/tedge";

export interface Config {
  // Enable debug logging
  debug?: boolean;
  // thin-edge.io measurement topic to publish the aggregated measurement to
  output_topic?: string;
  // Number of trailing topic segments used to build the measurement key.
  // key_depth=1 (default): last segment → group name, value stored flat.
  //   topic "sensors/humidity"             → { humidity: 60 }
  // key_depth=2: second-to-last → group, last → named series, value nested.
  //   topic "sensors/temperature/inside"   → { temperature: { inside: 23.5 } }
  //   topic "sensors/temperature/outside"  → { temperature: { outside: 30.1 } }  (merged)
  key_depth?: number;
}

export interface FlowContext extends Context {
  config: Config;
}

// depth=1: flat number per group; depth=2: named series map per group
type MeasurementBuffer = Record<string, number | Record<string, number>>;

function getBuffer(context: FlowContext): MeasurementBuffer {
  return context.flow.get("buffer") ?? {};
}

function setBuffer(context: FlowContext, buf: MeasurementBuffer): void {
  context.flow.set("buffer", buf);
}

/**
 * Extract the measurement group and optional series name from the last `depth`
 * segments of an MQTT topic.
 *
 * depth=1: group = last segment, series = undefined  → flat numeric value
 * depth=2: group = second-to-last, series = last     → nested series value
 *
 * Examples (depth=1):
 *   "sensors/humidity"            → { group: "humidity" }
 *   "sensors/room1/temperature"   → { group: "temperature" }
 *
 * Examples (depth=2):
 *   "sensors/temperature/inside"  → { group: "temperature", series: "inside" }
 *   "sensors/temperature/outside" → { group: "temperature", series: "outside" }
 */
export function extractMeasurementKey(
  topic: string,
  depth: number,
): { group: string; series?: string } {
  const segments = topic.split("/");
  if (depth >= 2 && segments.length >= 2) {
    return {
      group: segments[segments.length - 2],
      series: segments[segments.length - 1],
    };
  }
  return { group: segments[segments.length - 1] };
}

/**
 * Parse a raw MQTT payload into a numeric value.
 *
 * Supported payload formats:
 *   - Plain numeric string: "23.5"
 *   - JSON number: 23.5
 *   - JSON object with a "value" key: {"value": 23.5}
 *
 * Returns `undefined` if the payload cannot be interpreted as a number.
 */
export function parseNumericPayload(raw: string): number | undefined {
  const trimmed = raw.trim();

  if (trimmed === "") return undefined;

  // Fast path: plain numeric string
  const direct = Number(trimmed);
  if (Number.isFinite(direct)) return direct;

  // Try JSON
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "number" && Number.isFinite(parsed)) {
      return parsed;
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "value" in parsed &&
      Number.isFinite(Number(parsed.value))
    ) {
      return Number(parsed.value);
    }
  } catch {
    // not valid JSON – fall through
  }

  return undefined;
}

/**
 * Buffer an incoming single-topic datapoint into flow state.
 *
 * With key_depth=1 (default) the last topic segment becomes the measurement
 * group and the value is stored as a plain number (thin-edge flat format).
 *
 * With key_depth=2 the second-to-last segment is the group and the last
 * segment is a named series within that group.  Multiple messages sharing the
 * same group are merged, building a nested series map for that group.
 *
 * The value is not forwarded immediately; it is held until `onInterval` fires.
 */
export function onMessage(message: Message, context: FlowContext): Message[] {
  const { debug = false, key_depth = 1 } = context.config;

  if (debug) {
    console.log("onMessage config", { key_depth, raw_config: context.config });
  }

  const raw = decodePayload(message.payload);
  const value = parseNumericPayload(raw);

  if (value === undefined) {
    if (debug) {
      console.log("Skipping non-numeric payload", {
        topic: message.topic,
        payload: raw,
      });
    }
    return [];
  }

  const { group, series } = extractMeasurementKey(message.topic, key_depth);
  const buf = getBuffer(context);

  if (series !== undefined) {
    // Nested path: merge the incoming series into the group's series map
    const existing = (buf[group] as Record<string, number>) ?? {};
    buf[group] = { ...existing, [series]: value };
  } else {
    // Flat path: store the value directly under the group name
    buf[group] = value;
  }

  setBuffer(context, buf);

  if (debug) {
    console.log("Buffered datapoint", {
      topic: message.topic,
      group,
      series,
      value,
      bufferSize: Object.keys(buf).length,
    });
  }

  return [];
}

/**
 * Flush the buffered datapoints as a single thin-edge.io measurement.
 *
 * key_depth=1 produces flat measurement fragments:
 *   { "time": "...", "temperature": 23.5, "humidity": 60 }
 *
 * key_depth=2 produces named-series fragments and multiple topics with the
 * same group are merged into a single nested object:
 *   { "time": "...", "temperature": { "inside": 23.5, "outside": 30.1 } }
 *
 * Both formats are valid thin-edge.io measurement payloads.
 * The buffer is cleared after each flush so the next window starts fresh.
 */
export function onInterval(time: Date, context: FlowContext): Message[] {
  const { debug = false, output_topic = "te/device/main///m/aggregated" } =
    context.config;

  const buf = getBuffer(context);

  if (Object.keys(buf).length === 0) {
    if (debug) {
      console.log("onInterval: buffer is empty, nothing to emit");
    }
    return [];
  }

  const measurement: Record<string, any> = {
    time: time.toISOString(),
    ...buf,
  };

  // Clear the buffer so the next window starts fresh
  setBuffer(context, {});

  if (debug) {
    console.log("Emitting aggregated measurement", {
      output_topic,
      groupCount: Object.keys(buf).length,
    });
  }

  return [
    {
      time,
      topic: output_topic,
      payload: JSON.stringify(measurement),
    },
  ];
}
