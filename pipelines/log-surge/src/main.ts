/*
  Parse and filter journald log messages
*/

import * as model from "../../common/model";
import { Message, Timestamp, Run } from "./../../common/tedge";
import * as journald from "./journald";
import * as testing from "../../common/testing";

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

interface FlowState {
  stats: journald.Statistics;
  dateFrom: Number;
  dateTo: Number;
  ran: boolean;
}

// State
const state: FlowState = {
  stats: new journald.Statistics(),
  dateFrom: Date.now() / 1000,
  dateTo: Date.now() / 1000,
  ran: false,
};

export function version() {
  return "0.0.1";
}

export function get_state(): FlowState {
  return state;
}

export function process(
  timestamp: Timestamp,
  message: Message,
  config: Config | null,
) {
  const { with_logs = false, debug = false, text_filter = [] } = config || {};
  TEST: if (debug) {
    console.log("Calling process");
  }
  let payload = JSON.parse(message.payload);
  const output = journald.transform(payload);

  // Check data transform and reject invalid data
  model.assertFinite(output, "time");
  model.assertNonEmptyValue(output, "text");

  // Optional message filtering
  const contains = (text) => {
    return (element, index, array) => {
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
  state.stats[output.level] += 1;
  state.stats.total += 1;

  if (with_logs) {
    return [
      {
        topic: "stream/logs/journald",
        payload: JSON.stringify(output),
      },
    ];
  }
  return [];
}

export function tick(timestamp: Timestamp, config: Config | null) {
  const {
    debug = false,
    publish_statistics = false,
    stats_topic = "stats/logs",
    threshold = {},
  } = config || {};
  TEST: if (debug) {
    console.log("Calling tick");
  }

  const { info = 0, warning = 0, error = 0, total = 0 } = threshold;

  state.dateTo = timestamp.seconds + timestamp.nanoseconds / 1e9;
  const stats = state.stats;
  const output: Message[] = [];

  if (publish_statistics) {
    output.push({
      topic: `te/device/main///${stats_topic}`,
      payload: JSON.stringify(stats),
    });
  }

  const isAbove = (v, limit = 0) => {
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
      topic: `te/device/main///a/log_surge`,
      payload: JSON.stringify({
        text: alarmText,
        time: timestamp.seconds,
        severity: severity,
        statistics: stats,
      }),
    });
  } else if (state.ran) {
    TEST: if (debug) {
      console.log("clearing log_surge alarm (if present)");
    }
    output.push({
      topic: `te/device/main///a/log_surge`,
      retain: true,
      payload: ``,
    });
  }

  // reset statistics
  state.dateFrom = state.dateTo;
  state.stats.reset();
  state.ran = true;
  return output;
}

TEST: testing.run(1, "test", () => {
  const messages: Message[] = journald.mockJournaldLogs(10).map((value) => ({
    topic: "dummy",
    payload: JSON.stringify(value),
  }));
  const config: Config = {
    with_logs: true,
    publish_statistics: true,
    debug: false,
    threshold: {
      error: 1,
    },
  };
  return Run(
    {
      tick,
      process,
    },
    messages,
    config,
  );
});
