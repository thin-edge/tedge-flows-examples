/*
  Calculate the 
*/
import { Message, Timestamp, Run } from "../../common/tedge";
import { UptimeTracker, Status } from "./uptime";

const state = new UptimeTracker(10);

function fromTimestamp(t: Timestamp): number {
  return t.seconds * 1000 + t.nanoseconds / 1e6;
}

export interface Config {
  window_size_minutes?: number;
  stats_topic?: string;
  default_status?: Status;
}

export function onMessage(message: Message, config: Config | null = {}) {
  const { window_size_minutes = 1440 } = config || {};

  let status: Status = "online";
  if (message.payload === "0") {
    status = "offline";
  } else if (message.payload === "1") {
    status = "online";
  } else {
    let payload = JSON.parse(message.payload);
    const serviceStatus = payload["status"];
    if (serviceStatus === "up") {
      status = "online";
    } else if (serviceStatus === "down") {
      status = "offline";
    }
  }

  const timestamp_milliseconds = fromTimestamp(message.timestamp);
  if (
    !initTracker(state, window_size_minutes, status, timestamp_milliseconds)
  ) {
    state.updateStatus(status, timestamp_milliseconds);
  }

  return [];
}

export function onInterval(timestamp: Timestamp, config: Config | null) {
  const {
    window_size_minutes = 1440,
    stats_topic = "twin/onlineTracker",
    default_status = "uninitialized",
  } = config || {};

  if (
    initTracker(
      state,
      window_size_minutes,
      default_status,
      fromTimestamp(timestamp),
    )
  ) {
    return [];
  }

  if (state.isUninitialized()) {
    console.log(
      "UptimeTracker is not initialized, waiting for initial status of the subscribed topic",
    );
    return [];
  }

  const {
    percentage: onlineRaw,
    durationMs,
    interruptions,
  } = state.getUptimePercentage();
  const online = Math.round(onlineRaw * 1000) / 1000;
  const offline = parseFloat((100 - online).toFixed(3));
  const currentStatus = state.currentStatus();
  const output: Message[] = [
    {
      timestamp,
      topic: `te/device/main///${stats_topic}`,
      payload: JSON.stringify({
        online,
        offline,
        durationSeconds: Math.round(durationMs / 1000),
        interruptions,
        currentStatus,
      }),
    },
  ];
  return output;
}

let trackerInitialized = false;

/**
 * Initialize the tracker only once. Accepts the state (UptimeTracker instance) and any reset arguments.
 */
export function initTracker(
  tracker: UptimeTracker,
  windowSizeMinutes: number,
  initialStatus: Status,
  initialTimestamp?: number,
): boolean {
  if (!trackerInitialized) {
    tracker.reset(windowSizeMinutes, initialStatus, initialTimestamp);
    trackerInitialized = true;
    return true;
  }
  return false;
}
