/*
  Parse and filter journald log messages
*/

import * as model from "../../common/model";
import { Message, Context, decodeJsonPayload } from "./../../common/tedge";
import * as journald from "./journald";

export interface Config {
  // Enable debug logging
  debug?: boolean;
  with_logs?: boolean;
  publish_statistics?: boolean;
  stats_topic?: string;
  text_filter?: string[];
  threshold?: {
    info?: number;
    warning?: number;
    error?: number;
    total?: number;
  };
}

export interface FlowContext extends Context {
  config: Config;
}

export function createStatistics(): Statistics {
  return <Statistics>{
    emerg: 0,
    alert: 0,
    crit: 0,
    err: 0,
    warn: 0,
    notice: 0,
    info: 0,
    debug: 0,
    total: 0,
    unknown: 0,
  };
}

export interface Statistics {
  [key: string]: number;
  emerg: number;
  alert: number;
  crit: number;
  err: number;
  warn: number;
  notice: number;
  info: number;
  debug: number;
  total: number;
  unknown: number;
}

export interface FlowState {
  stats: Statistics;
  dateFrom: Number;
  dateTo: Number;
  ran: boolean;
}

export function getState(context: FlowContext): FlowState {
  return (
    context.flow.get("state") ||
    <FlowState>{
      stats: createStatistics(),
      dateFrom: Date.now() / 1000,
      dateTo: Date.now() / 1000,
      ran: false,
    }
  );
}

export function setState(context: FlowContext, value: FlowState): void {
  context.flow.set("state", value);
}

export function updateState(
  context: FlowContext,
  fn: (v: FlowState) => FlowState,
) {
  const current = getState(context);
  setState(context, fn(current));
}

export function onMessage(message: Message, context: FlowContext): Message[] {
  const {
    with_logs = false,
    debug = false,
    text_filter = [],
  } = context.config || {};
  let payload = decodeJsonPayload(message.payload);
  const output = journald.transform(payload);

  // Check data transform and reject invalid data
  model.assertFinite(output, "time");
  model.assertNonEmptyValue(output, "text");

  // Optional message filtering
  const contains = (text: string) => {
    return (element: RegExp, index: number, array: RegExp[]) => {
      return element.test(text);
    };
  };
  if (!text_filter.map((v) => RegExp(v)).every(contains(output.text))) {
    TEST: if (debug) {
      console.log("Skipping message as it did not match the text filter", {
        text_filter,
      });
    }
    return [];
  }

  // Record statistics
  updateState(context, (current: FlowState) => {
    current.stats[output.level] = (current.stats[output.level] || 0) + 1;
    current.stats.total += 1;
    return current;
  });

  if (with_logs) {
    return [
      {
        time: message.time,
        topic: "stream/logs/journald",
        payload: JSON.stringify(output),
      },
    ];
  }
  return [];
}

export function onInterval(time: Date, context: FlowContext) {
  const {
    debug = false,
    publish_statistics = false,
    stats_topic = "stats/logs",
    threshold = {},
  } = context.config || {};
  TEST: if (debug) {
    console.log("Calling tick");
  }

  const { info = 0, warning = 0, error = 0, total = 0 } = threshold;
  const state = getState(context);

  state.dateTo = time.getTime() / 1000;
  const stats = state.stats;
  const output: Message[] = [];

  if (publish_statistics) {
    output.push({
      time,
      topic: `te/device/main///${stats_topic}`,
      payload: JSON.stringify(stats),
    });
  }

  const isAbove = (v: number, limit: number = 0) => {
    return limit != 0 && Number.isInteger(v) && v >= limit;
  };

  let alarmText = "";
  let severity = "";

  if (isAbove(stats.total, total)) {
    alarmText = `Logging surge detected. Too many log messages detected. total: ${stats.total}, threshold=${total}`;
    severity = "major";
  } else if (isAbove(stats.err, error)) {
    alarmText = `Logging surge detected. Too many error messages detected. current=${stats.err}, threshold=${error}`;
    severity = "major";
  } else if (isAbove(stats.warn, warning)) {
    alarmText = `Logging surge detected. Too many warning messages detected. current=${stats.warn}, threshold=${warning}`;
    severity = "minor";
  } else if (isAbove(stats.info, info)) {
    alarmText = `Logging surge detected. Too many info messages detected. current=${stats.info}, threshold=${info}`;
    severity = "warning";
  }

  if (alarmText) {
    output.push({
      time,
      topic: `te/device/main///a/log_surge`,
      payload: JSON.stringify({
        text: alarmText,
        time: time.toISOString(),
        severity: severity,
        statistics: stats,
      }),
    });
  } else if (state.ran) {
    TEST: if (debug) {
      console.log("clearing log_surge alarm (if present)");
    }
    output.push({
      time,
      topic: `te/device/main///a/log_surge`,
      mqtt: { retain: true },
      payload: ``,
    });
  }

  // reset statistics
  state.dateFrom = state.dateTo;
  state.stats = createStatistics();
  state.ran = true;
  setState(context, state);
  return output;
}
