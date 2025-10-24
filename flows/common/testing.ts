import { spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import * as tedge from "./tedge";

// Extend the globalThis type to include scriptArgs and process
declare global {
  var scriptArgs: string[] | undefined;
  var process: { argv: string[] } | undefined;
}

var scriptArgs: string[];
var process: any;

export interface Program {
  command: string;
  engine: string;
}

export function getCommand(n: number): Program | undefined {
  if (
    typeof globalThis.scriptArgs !== "undefined" &&
    Array.isArray(globalThis.scriptArgs)
  ) {
    return {
      command: globalThis.scriptArgs[n],
      engine: "quickjs",
    };
  } else if (
    typeof globalThis.process !== "undefined" &&
    Array.isArray(globalThis.process.argv)
  ) {
    return {
      command: globalThis.process.argv[n + 1],
      engine: "v8 (nodejs/deno etc.)",
    };
  }
}

export function run(n: number, name: string, callback: CallableFunction): void {
  const program = getCommand(n);
  if (program?.command == name) {
    callback();
  }
}

export interface TedgeCommandOutput {
  topic: string;
  payload: string;
}

// Dynamically find the project root by looking for package.json upwards from __dirname
function findProjectRoot(dir: string = __dirname): string {
  let currentDir = dir;
  while (true) {
    if (fs.existsSync(path.join(currentDir, "package.json"))) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  throw new Error("Could not find project root (package.json not found)");
}

export function runCommand(
  projectDir: string,
  m: tedge.Message,
): TedgeCommandOutput {
  const input = `[${m.topic}] ${m.payload}`;
  const result = spawnSync(
    "tedge",
    ["flows", "test", "--flows-dir", findProjectRoot(projectDir)],
    { input, encoding: "utf-8" },
  );
  expect(result.status).toBe(0);

  // parse the command output
  const i = result.stdout.indexOf("] ");
  const topic = result.stdout.substring(1, i);
  const payload = result.stdout.substring(i + 2).trimEnd();
  return {
    topic,
    payload,
  };
}

export function replaceTimestamps(
  obj: any,
  prop: string,
  newTimestamp: string,
): any {
  if (Array.isArray(obj)) {
    return obj.map((item) => replaceTimestamps(item, prop, newTimestamp));
  } else if (obj && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [
        key,
        key === prop
          ? newTimestamp
          : replaceTimestamps(value, prop, newTimestamp),
      ]),
    );
  }
  return obj;
}

export function isTedgeAvailable(): boolean {
  try {
    const result = spawnSync("tedge", ["--version"], { encoding: "utf-8" });
    return result.status === 0;
  } catch {
    return false;
  }
}
