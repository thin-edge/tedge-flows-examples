/*
  Calculate the 
*/
import { Message, Context, decodeJsonPayload } from "../../common/tedge";
import { UptimeTracker, Status, StatusChange } from "./uptime";

export interface Config {
  window_size_minutes?: number;
  stats_topic?: string;
}

export interface FlowContext extends Context {
  config: Config;
}

function getHistory(context: FlowContext): StatusChange[] {
  return context.flow.get("history") || [];
}

export function onMessage(message: Message, context: FlowContext): Message[] {
  const { window_size_minutes = 1440 } = context.config || {};

  const history = getHistory(context);
  const state = new UptimeTracker(window_size_minutes, history);

  let status: Status = "online";
  if (message.payload === "0") {
    status = "offline";
  } else if (message.payload === "1") {
    status = "online";
  } else {
    let payload = decodeJsonPayload(message.payload);
    const serviceStatus = payload["status"];
    if (serviceStatus === "up") {
      status = "online";
    } else if (serviceStatus === "down") {
      status = "offline";
    }
  }
  context.flow.set(
    "history",
    state.updateStatus(status, message.time.getTime()),
  );

  return [];
}

export function onInterval(time: Date, context: FlowContext) {
  const { window_size_minutes = 1440, stats_topic = "twin/onlineTracker" } =
    context.config || {};

  const history = getHistory(context);

  if (history.length === 0) {
    console.log("onInterval: history hasn't been initialized");
    return [];
  }

  const state = new UptimeTracker(window_size_minutes, history);

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
      time: time,
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
