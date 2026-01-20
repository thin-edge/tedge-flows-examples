import { Message, isMainDevice } from "../../common/tedge";

export interface Config {
  cloud_topic_prefix?: string;
  pretty_print?: boolean;
}

function getCloudID(topic: string): string | undefined {
  const [_, deviceName, childDevice] = topic.split("/");
  return [deviceName, childDevice].join("_");
}

function convertToMetrics(payload: object, timestamp = "", prefix = ""): any {
  const metrics = [];
  for (const [key, value] of Object.entries(payload)) {
    const metricKey = prefix ? `${prefix}_${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      metrics.push(...convertToMetrics(value, timestamp, metricKey));
    } else {
      metrics.push({ name: metricKey, value, timestamp });
    }
  }
  return metrics;
}

export function onMessage(message: Message, config: Config | null = {}) {
  const { cloud_topic_prefix = "azeg/DDATA", pretty_print = false } =
    config || {};
  if (isMainDevice(message.topic)) {
    console.debug("Skipping messages for the main device", {
      topic: message.topic,
    });
    return [];
  }

  const payload = JSON.parse(`${message.payload}`);
  const receivedAt = message.time?.toISOString();
  const timestamp = payload.time || receivedAt;

  const output = [];
  const cloudID = getCloudID(message.topic);
  if (!cloudID) {
    // ignore messages for the main device
    return [];
  }
  output.push({
    topic: [cloud_topic_prefix, cloudID].join("/"),
    payload: JSON.stringify(
      {
        timestamp: receivedAt,
        uuid: cloudID,
        metrics: convertToMetrics(payload, timestamp),
      },
      null,
      pretty_print ? "  " : "",
    ),
  });
  return output;
}
