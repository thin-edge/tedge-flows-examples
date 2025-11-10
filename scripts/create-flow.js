const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

let projectName = "";
if (process.argv.length > 1) {
  projectName = process.argv[2];
}
if (!projectName) {
  console.error("ERROR: You must provide a flow name!");
  process.exit(1);
}

const packageTemplate = {
  name: projectName,
  version: "0.0.1",
  description: "Flow description",
  source: "src/main.ts",
  module: "dist/main.mjs",
  type: "module",
  scripts: {
    build:
      "esbuild src/main.ts --target=es2018 --bundle --outfile=dist/main.mjs --format=esm --drop-labels=DEV,TEST",
    test: "jest --coverageProvider=v8 --coverage",
  },
  author: "thin-edge.io",
  license: "Apache-2.0",
  devDependencies: {
    "@faker-js/faker": "^9.9.0",
    "@types/jest": "^30.0.0",
    esbuild: "^0.25.5",
    "esbuild-register": "^3.6.0",
    jest: "^30.0.4",
    "jest-esbuild": "^0.4.0",
    prettier: "3.6.2",
    typescript: "^5.8.3",
  },
};

const templateFlow = `
[input]
mqtt.topics = [
    "example/foo/bar",
]

[[steps]]
script = "dist/main.mjs"
config.debug = 1440
config.custom_prop = "my/prop"
`.trimStart();

const templateREADME = `
## ${projectName}

This flows converts messages from an input topic.

### Description

The flow processes messages as follows:

1. step 1
1. step 2

`.trimStart();

const templateMainTS = `
import { Message, Context, decodeJSON, encodeJSON } from "../../common/tedge";

export interface Config {
  debug?: boolean;
  custom_prop?: string;
}

export function onMessage(message: Message, context: Context): Message[] {
  const output = [];
  const config: Config = context.config;

  // TODO: append any messages you want to the output array.
  const topicSegments = message.topic.split("/");
  const payload = decodeJSON(message.payload);
  output.push({
    topic: \`te/device/\${topicSegments[1]}///m/\${topicSegments[topicSegments.length - 1]}\`,
    payload: encodeJSON({
      time: message.time.toISOString(),
      ...payload,
    }),
  });

  return output;
}
`.trimStart();

const templateTestFile = `
import { expect, test, describe } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

describe("map messages", () => {
  test("simple message", () => {
    const output = flow.onMessage({
      time: new Date("2025-01-01"),
      topic: "example/foo/bar",
      payload: encodeJSON({
        temperature: 23.0,
      }),
    });
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/device/foo///m/bar");
    const payload = decodeJSON(output[0].payload);
    expect(payload).toEqual({
      time: "2025-01-01T00:00:00.000Z",
      temperature: 23.0,
    });
  });
});
`.trimStart();

function generateProject(name) {
  const projectDir = path.join("flows", name);
  console.log(`Creating new flow: ${name}`, {
    name,
    projectDir,
  });
  if (fs.existsSync(projectDir)) {
    console.log("Project directory already exists");
    return;
  }
  fs.mkdirSync(projectDir);
  fs.writeFileSync(
    path.join(projectDir, "package.json"),
    JSON.stringify(packageTemplate, null, "  "),
  );
  fs.writeFileSync(path.join(projectDir, "flow.toml"), templateFlow);
  fs.writeFileSync(path.join(projectDir, "README.md"), templateREADME);

  fs.mkdirSync(path.join(projectDir, "src"));
  fs.writeFileSync(path.join(projectDir, "src", "main.ts"), templateMainTS);
  fs.mkdirSync(path.join(projectDir, "tests"));
  fs.writeFileSync(
    path.join(projectDir, "tests", "main.test.ts"),
    templateTestFile,
  );

  // update package lock file and format files
  execSync("npm install");
  execSync("npm run format");

  console.log(`\nSuccessfully created new flow: ${name}\n`);
}

generateProject(projectName);
process.exit(0);
