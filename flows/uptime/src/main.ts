/*
  Calculate the 
*/
import { Message, Context, decodeText, encodeJSON } from "../../common/tedge";
import { UptimeTracker, Status } from "./uptime";

const state = new UptimeTracker(10);

export interface Config {
  window_size_minutes?: number;
  stats_topic?: string;
  default_status?: Status;
}

export function onMessage(message: Message, context: Context) {
  const { window_size_minutes = 1440 } = context.config || {};

  let status: Status = "online";
  const payload = decodeText(message.payload);
  if (payload === "0") {
    status = "offline";
  } else if (payload === "1") {
    status = "online";
  } else {
    let payloadJSON = JSON.parse(payload);
    const serviceStatus = payloadJSON["status"];
    if (serviceStatus === "up") {
      status = "online";
    } else if (serviceStatus === "down") {
      status = "offline";
    }
  }

  const timestamp_milliseconds = message.time?.getTime();
  if (
    !initTracker(state, window_size_minutes, status, timestamp_milliseconds)
  ) {
    state.updateStatus(status, timestamp_milliseconds);
  }

  return [];
}

export function onInterval(time: Date, context: Context) {
  const {
    window_size_minutes = 1440,
    stats_topic = "twin/onlineTracker",
    default_status = "uninitialized",
  } = context.config || {};

  if (initTracker(state, window_size_minutes, default_status, time.getTime())) {
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
      time,
      topic: `te/device/main///${stats_topic}`,
      payload: encodeJSON({
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
