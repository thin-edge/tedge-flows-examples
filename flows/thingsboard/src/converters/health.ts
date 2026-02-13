import { FlowContext, ENTITY_TO_HEALTH_STATUS_PREFIX } from "../main";
import { formatTelemetryMessage } from "../utils";

interface HealthPayload {
  pid?: number;
  status?: string;
  time?: number;
  [key: string]: any;
}

interface HealthTelemetry {
  "health::status": string;
  "health::pid"?: number;
  [key: string]: any;
}

/**
 * Convert thin-edge.io health status to ThingsBoard telemetry
 *
 * Handles two cases:
 * 1. Normal service health: {"pid":128,"status":"up","time":1770717141.5398614}
 * 2. Mosquitto bridge health: 1 or 0 (number only)
 *
 * and stores the latest health status in the script KV store for heartbeat.
 */
export function convertHealthToTelemetry(
  context: FlowContext,
  payload: any,
  deviceName: string,
  entityId: string,
  isMain: boolean,
) {
  const telemetryEntry = buildHealthTelemetry(payload);

  if (telemetryEntry) {
    const status = telemetryEntry["health::status"];
    context.script.set(`${ENTITY_TO_HEALTH_STATUS_PREFIX}${entityId}`, status);

    return formatTelemetryMessage(deviceName, telemetryEntry, isMain);
  }

  return [];
}

/**
 * Build health telemetry object from payload
 */
function buildHealthTelemetry(payload: any): any | null {
  // Parse payload if it's a string
  let parsedPayload = payload;
  if (typeof payload === "string") {
    try {
      parsedPayload = JSON.parse(payload);
    } catch {
      // If parsing fails, it might be invalid
      return null;
    }
  }

  // Handle mosquitto bridge special case: 0 or 1 (number only)
  if (typeof parsedPayload === "number") {
    if (parsedPayload === 0 || parsedPayload === 1) {
      return {
        "health::status": parsedPayload === 1 ? "up" : "down",
      };
    }
    // Invalid number payload
    return null;
  }

  // Handle normal JSON health payload
  if (typeof parsedPayload === "object" && parsedPayload !== null) {
    const healthPayload = parsedPayload as HealthPayload;
    const telemetryValues: HealthTelemetry = {
      "health::status": healthPayload.status || "unknown",
    };

    // Add optional fields
    if (healthPayload.pid !== undefined) {
      telemetryValues["health::pid"] = healthPayload.pid;
    }

    // Include any additional custom fields
    for (const [key, value] of Object.entries(healthPayload)) {
      if (!["status", "pid", "time"].includes(key)) {
        telemetryValues[`health::${key}`] = value;
      }
    }

    if (healthPayload.time !== undefined) {
      return {
        ts: Math.floor(healthPayload.time * 1000),
        values: telemetryValues,
      };
    }

    return telemetryValues;
  }

  // Invalid payload type
  return null;
}
