import { Message } from "./../../common/tedge";

interface Config {
  disable_twin?: boolean;
  disable_alarms?: boolean;
  alarm?: string;
  warning?: string;
  twin_property?: string;
  debug?: boolean;
}

function camelize(value: string) {
  return value
    .replace(/(?:^\w|[A-Z]|\b\w)/g, function (word, index) {
      return index === 0 ? word.toLowerCase() : word.toUpperCase();
    })
    .replace(/\s+/g, "");
}

function parseInputMessage(payload: string) {
  return payload
    .split("\u0000")
    .filter((item) => item)
    .reduce((props, item) => {
      const [key, ...values] = item.split(":") || [];
      const value = values.join(":");
      if (key && values.length > 0) {
        props[camelize(key)] = value.trimStart();
      }
      return props;
    }, {} as any);
}

function parseDuration(value_str: string) {
  // Supports formats like "90d", "12h", "30m", "45s", "100ms", and compound values like "90d 12h"
  const regex = /(\d+)\s*(d|h|m|s|ms)/gi;
  let total = 0;
  let match;
  while ((match = regex.exec(value_str)) !== null) {
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    switch (unit) {
      case "d":
        total += value * 24 * 60 * 60 * 1000;
        break;
      case "h":
        total += value * 60 * 60 * 1000;
        break;
      case "m":
        total += value * 60 * 1000;
        break;
      case "s":
        total += value * 1000;
        break;
      case "ms":
        total += value;
        break;
    }
  }
  return total || NaN;
}

const deduplicateCalls = (fn: Function) => {
  const cache = new Map();
  return function (...args: any[]): any[] {
    const key: string = JSON.stringify(args);
    if (cache.has(key)) {
      // return cache.get(key);
      return [];
    }
    const result: any[] = fn(...args);
    cache.set(key, result);
    return result;
  };
};

const checkThresholds = deduplicateCalls(function (
  expiresAt: number,
  details: any,
  config: any,
) {
  const {
    alarm = "30d",
    warning = "60d",
    alarm_type = "certificateExpiresSoon",
    debug = false,
  } = config;
  const alarm_threshold = parseDuration(alarm);
  const warning_threshold = parseDuration(warning);
  if (isNaN(alarm_threshold)) {
    console.error("Invalid alarm threshold format", {
      got: alarm,
      wanted: "duration as a string, e.g. '90d'",
    });
  }
  if (isNaN(warning_threshold)) {
    console.error("Invalid warning threshold format", {
      got: warning,
      wanted: "duration as a string, e.g. '90d'",
    });
  }

  const expiresIn = expiresAt - Date.now();
  if (debug) {
    console.debug(`Checking certificate`, {
      expiresAt: expiresAt / 1000,
      expiresIn: expiresIn / 1000,
      alarm_threshold: alarm_threshold / 1000,
      warning_threshold: warning_threshold / 1000,
      now: Date.now(),
    });
  }

  const topicAlarm = `te/device/main///a/${alarm_type}_alarm`;
  const topicWarning = `te/device/main///a/${alarm_type}_warn`;

  const messages = [];
  if (expiresIn <= alarm_threshold) {
    messages.push({
      topic: topicAlarm,
      retain: true,
      payload: JSON.stringify({
        text: `Certificate will expire within ${alarm}`,
        severity: "major",
        details,
      }),
    });
    messages.push({
      topic: topicWarning,
      retain: true,
      payload: "",
    });
  } else if (expiresIn <= warning_threshold) {
    messages.push({
      topic: topicWarning,
      retain: true,
      payload: JSON.stringify({
        text: `Certificate will expire within ${warning}`,
        severity: "warning",
        details,
      }),
    });
    messages.push({
      topic: topicAlarm,
      retain: true,
      payload: "",
    });
  } else {
    // Clear alarms
    messages.push({
      topic: topicAlarm,
      retain: true,
      payload: "",
    });
    messages.push({
      topic: topicWarning,
      retain: true,
      payload: "",
    });
  }
  return messages;
});

function toJSON(payload: any, debug: boolean = false) {
  if (debug === true) {
    return JSON.stringify(payload, null, "  ");
  }
  return JSON.stringify(payload);
}

const publishTwinMessage = deduplicateCalls(function (
  output: any,
  config: Config,
) {
  return [
    {
      topic: `te/device/main///twin/${config?.twin_property || "tedge_Certificate"}`,
      retain: true,
      payload: toJSON(output, config?.debug),
    },
  ];
});

export function onMessage(message: Message, config: Config = {}): Message[] {
  console.debug("Input", {
    topic: message.topic,
    payload: message.payload,
  });
  const fragment = parseInputMessage(message.payload);

  const expiresAt = new Date(fragment.validUntil);
  let signedBy = "-";
  if (fragment.issuer === fragment.subject) {
    signedBy = "self";
  } else if (fragment.issuer.match(/CN=t[0-9]+\b/)) {
    signedBy = "c8y-ca";
  } else {
    signedBy = "ca";
  }
  const output = {
    subject: fragment.subject,
    issuer: fragment.issuer,
    status: fragment.status.replace(/ *\(.+\)$/, ""),
    validFrom: new Date(fragment.validFrom).toISOString(),
    validUntil: expiresAt.toISOString(),
    signedBy,
    // Extract hex number in brackets, without 0x prefix
    serialNumberHex: (() => {
      const match = fragment.serialNumber.match(/\(0x([a-f0-9]+)\)/i);
      return match ? match[1] : fragment.serialNumber;
    })(),
  };

  const outputMessages = [];
  if (!config?.disable_twin) {
    outputMessages.push(...publishTwinMessage(output, config));
  }

  if (!config?.disable_alarms) {
    outputMessages.push(
      ...checkThresholds(expiresAt.getTime(), output, config),
    );
  }
  return outputMessages;
}
