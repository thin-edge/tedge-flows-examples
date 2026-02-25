/*
  Calculate the 
*/
import { Message, Context, decodePayload } from "../../common/tedge";
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
  const payload = decodePayload(message.payload);

  let status: Status = "online";
  if (payload === "0") {
    status = "offline";
  } else if (payload === "1") {
    status = "online";
  } else {
    try {
      const heathStatus = JSON.parse(payload)["status"];
      if (heathStatus === "up") {
        status = "online";
      } else if (heathStatus === "down") {
        status = "offline";
      }
    } catch (err) {
      console.warn(`Failed to parse json message. error=${err}`);
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
      mqtt: { retain: true },
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
