import { faker } from "@faker-js/faker";

const priorities = {
  "0": "emerg",
  "1": "alert",
  "2": "crit",
  "3": "err",
  "4": "warn",
  "5": "notice",
  "6": "info",
  "7": "debug",
};

interface LogEntry {
  time?: number;
  name?: string;
  systemdUnit?: string;
  level: string;
  text: string;
}

export function stripTimestampPrefix(text: string): string {
  return text.replace(/^(\d{10,}:|\d{4}-\d{1,2}-\d{1,2}\S+) +/, "");
}

export function parseTimestamp(text: string): number | undefined {
  return parseInt(text, 10) / 1e6 || undefined;
}

export function transform(payload: any): LogEntry {
  const output: LogEntry = {
    time: parseTimestamp(
      payload._SOURCE_REALTIME_TIMESTAMP || payload.__REALTIME_TIMESTAMP,
    ),
    name: payload.SYSLOG_IDENTIFIER,
    systemdUnit: payload._SYSTEMD_UNIT,
    level:
      priorities[String(payload.PRIORITY) as keyof typeof priorities] ||
      "unknown",
    text: stripTimestampPrefix(payload.MESSAGE || ""),
  };

  // service is not writing directly to syslog, so the log level needs to be parsed from the message
  if (!payload["SYSLOG_TIMESTAMP"]) {
    if (output.text.match(/ (ERROR|ERR) /i)) {
      output.level = "err";
    } else if (output.text.match(/ (WARNING|WARN) /i)) {
      output.level = "warn";
    } else if (output.text.match(/ INFO +/i)) {
      output.level = "info";
    } else if (output.text.match(/ (TRACE|DEBUG) +/i)) {
      output.level = "debug";
    }
  }
  return output;
}

export interface JOURNALD_RAW_MESSAGE {
  _RUNTIME_SCOPE?: string;
  _UID?: string;
  _PID?: string;
  _BOOT_ID?: string;
  _MACHINE_ID?: string;
  _CMDLINE?: string;
  _SYSTEMD_INVOCATION_ID?: string;
  _SYSTEMD_SLICE?: string;
  _SYSTEMD_UNIT?: string;
  __MONOTONIC_TIMESTAMP?: string;
  PRIORITY?: string;
  _CAP_EFFECTIVE?: string;
  __REALTIME_TIMESTAMP?: string;
  __CURSOR?: string;
  SYSLOG_PID?: string;
  _SYSTEMD_CGROUP?: string;
  MESSAGE?: string;
  _HOSTNAME?: string;
  _EXE?: string;
  _COMM?: string;
  _GID?: string;
  SYSLOG_IDENTIFIER?: string;
  _TRANSPORT?: string;
  _SOURCE_REALTIME_TIMESTAMP?: string;
  SYSLOG_TIMESTAMP?: string;
}

function generateMockEntry(i?: number): JOURNALD_RAW_MESSAGE {
  const now_us = Date.now() * 1000;
  const monotonic_us = now_us - 1459375200 * 1000 * 1000;
  const processName = faker.helpers.arrayElement([
    "ssh",
    "tedge-agent",
    "tedge-mapper",
  ]);
  return {
    _RUNTIME_SCOPE: "system",
    _UID: "" + faker.number.int({ min: 1, max: 1000 }),
    _PID: "" + faker.number.int({ min: 1, max: 1000 }),
    _BOOT_ID: faker.string.hexadecimal({ length: 32 }),
    _MACHINE_ID: "81d5a11353a5475bad1e02857e609b6f",
    _CMDLINE: `"${processName}: root [priv]"`,
    _SYSTEMD_INVOCATION_ID: "e14221401600416cad0f0bb45b304076",
    _SYSTEMD_SLICE: "system.slice",
    _SYSTEMD_UNIT: `${processName}.service`,
    __MONOTONIC_TIMESTAMP: `${monotonic_us}`,
    PRIORITY: `${faker.number.int(7)}`,
    _CAP_EFFECTIVE: faker.string.hexadecimal({ length: 11 }),
    __REALTIME_TIMESTAMP: `${now_us}`,
    __CURSOR: `s=${faker.string.hexadecimal({ length: 32 })};i=${faker.string.hexadecimal({ length: 5 })};b=${faker.string.hexadecimal({ length: 32 })};m=${faker.string.hexadecimal({ length: 10 })};t=${faker.string.hexadecimal({ length: 13 })};x=${faker.string.hexadecimal({ length: 16 })}`,
    SYSLOG_PID: "" + faker.number.int({ min: 1, max: 1000 }),
    _SYSTEMD_CGROUP: `/system.slice/${processName}.service`,
    MESSAGE: "Dummy log message",
    _HOSTNAME: "linux01",
    _EXE: `${processName} -f`,
    _COMM: processName,
    _GID: "0",
    SYSLOG_IDENTIFIER: processName,
    _TRANSPORT: "syslog",
    _SOURCE_REALTIME_TIMESTAMP: `${now_us}`,
    SYSLOG_TIMESTAMP: "",
  };
}

export function mockJournaldLogs(length: number = 10): any[] {
  return Array(length)
    .fill(null)
    .map((_, i) => generateMockEntry(i));
}
