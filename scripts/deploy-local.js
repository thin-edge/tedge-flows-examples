#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { parseArgs } = require("node:util");

const { positionals, values: args } = parseArgs({
  options: {
    help: {
      type: "boolean",
      short: "h",
      default: false,
    },
    "config-dir": {
      type: "string",
      default: process.env.TEDGE_CONFIG_DIR || "/etc/tedge",
    },
    "skip-build": {
      type: "boolean",
      short: "s",
      default: false,
    },
  },
  allowPositionals: true,
});

if (args.help || positionals.length === 0) {
  console.log(`
  Usage: node deploy-local.js [options] <flow>

  Options:
    -h, --help              Show this help message
    --config-dir DIR        thin-edge.io config directory (default: /etc/tedge)
    -s, --skip-build        Skip the build and package steps

  Arguments:
    flow                    Flow name, e.g. uptime

  Environment Variables:
    TEDGE_CONFIG_DIR        Overrides --config-dir (default: /etc/tedge)

  Examples:
    node deploy-local.js uptime
    node deploy-local.js --config-dir /tmp/tedge uptime
    node deploy-local.js --skip-build uptime
  `);
  process.exit(args.help ? 0 : 1);
}

const flowArg = positionals[0];
const tedgeConfigDir = args["config-dir"];
const smPlugin = path.join(tedgeConfigDir, "sm-plugins", "flow");

if (!fs.existsSync(smPlugin)) {
  console.error(`Error: Flow sm-plugin does not exist: ${smPlugin}`);
  process.exit(1);
}

// Derive the flow directory name from the last segment of the flow identifier
// e.g. "local/uptime" -> "uptime"
const flowDirName = path.basename(flowArg);

// Read version and mapper from the flow's package.json
const packageJsonPath = path.join(
  __dirname,
  "..",
  "flows",
  flowDirName,
  "package.json",
);
if (!fs.existsSync(packageJsonPath)) {
  console.error(
    `Error: package.json not found for flow '${flowDirName}': ${packageJsonPath}`,
  );
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
const version = pkg.version;
if (!version) {
  console.error(`Error: 'version' field missing in ${packageJsonPath}`);
  process.exit(1);
}

// Resolve the fully-qualified flow name: use the provided prefix if given,
// otherwise fall back to the mapper field in package.json, then "local"
const mapper = pkg.tedge?.mapper || "local";
const flow = flowArg.includes("/") ? flowArg : `${mapper}/${flowArg}`;

// Build and package the flow unless skipped
if (!args["skip-build"]) {
  const rootDir = path.join(__dirname, "..");

  console.log(`Building flow '${flowDirName}'...`);
  const build = spawnSync("npm", ["run", "build", "--workspace", flowDirName], {
    stdio: "inherit",
    cwd: rootDir,
  });
  if (build.status !== 0) process.exit(build.status ?? 1);

  console.log(`Packaging flow '${flowDirName}'...`);
  const publish = spawnSync(
    "node",
    [path.join(__dirname, "publish-images.js"), flowDirName],
    { stdio: "inherit", cwd: rootDir },
  );
  if (publish.status !== 0) process.exit(publish.status ?? 1);
}

// Build the dist file path — '/' in the flow name is URL-encoded as '%2F'
const flowEscaped = flow.replaceAll("/", "%2F");
const distFile = path.join(
  __dirname,
  "..",
  "dist",
  `${flowEscaped}_${version}.tar.gz`,
);

if (!fs.existsSync(distFile)) {
  console.error(`Error: Distribution file not found: ${distFile}`);
  process.exit(1);
}

console.log(
  `Installing flow '${flow}' version '${version}' from '${distFile}'...`,
);

const result = spawnSync(
  smPlugin,
  ["install", flow, "--module-version", version, "--file", distFile],
  { stdio: "inherit" },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Flow '${flow}' installed successfully.`);
