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
  "health::timestamp"?: number;
  [key: string]: any;
}

/**
 * Convert thin-edge.io health status to ThingsBoard telemetry
 *
 * Handles two cases:
 * 1. Normal service health: {"pid":128,"status":"up","time":1770717141.5398614}
 * 2. Mosquitto bridge health: 1 or 0 (number only)
 */
export function convertHealthToTelemetry(
  payload: any,
  deviceName: string,
  isMain: boolean,
) {
  const telemetryEntry = buildHealthTelemetry(payload);

  if (telemetryEntry) {
    return formatTelemetryMessage(deviceName, telemetryEntry, isMain);
  }

  return [];
}

/**
 * Build health telemetry object from payload
 */
function buildHealthTelemetry(payload: any): HealthTelemetry | null {
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
    const telemetry: HealthTelemetry = {
      "health::status": healthPayload.status || "unknown",
    };

    // Add optional fields
    if (healthPayload.pid !== undefined) {
      telemetry["health::pid"] = healthPayload.pid;
    }

    if (healthPayload.time !== undefined) {
      // Convert to milliseconds for ThingsBoard
      telemetry["health::timestamp"] = Math.floor(healthPayload.time * 1000);
    }

    // Include any additional custom fields
    for (const [key, value] of Object.entries(healthPayload)) {
      if (!["status", "pid", "time"].includes(key)) {
        telemetry[`health::${key}`] = value;
      }
    }

    return telemetry;
  }

  // Invalid payload type
  return null;
}
