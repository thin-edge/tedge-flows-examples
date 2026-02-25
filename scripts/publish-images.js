const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseArgs } = require("node:util");

// arg parsing
const { positionals: flows, values: args } = parseArgs({
  options: {
    help: {
      type: "boolean",
      short: "h",
      default: false,
    },
    // Targets where the flow should be published to: only supports 'registry'
    target: {
      type: "string",
      default: "",
    },
  },
  allowPositionals: true,
});

if (args.help) {
  console.log(`
  Usage: node publish-images.js [options] [flows...]

  Options:
    -h, --help          Show this help message
    --target TARGET     Comma-separated list of publish targets (e.g., 'registry')

  Arguments:
    flows               Optional flow directory names to publish (defaults to all workspaces)

  Examples:
    node publish-images.js
    node publish-images.js --target registry
    node publish-images.js flow1 flow2
    node publish-images.js --target registry flow1 flow2

  Environment Variables:
    REGISTRY            Container registry URL (default: ghcr.io)
    OWNER               Registry owner/namespace (default: thin-edge)
  `);
  process.exit(0);
}

const publishToRegistry = args.target
  .split(",")
  .map((v) => v.trim())
  .includes("registry");
console.log(`publishToRegistry: ${publishToRegistry}`);

const flowFilename = "flow.toml";
const registry = process.env.REGISTRY || "ghcr.io";
const owner = process.env.OWNER || "thin-edge";

let workspaces = "--workspaces";
if (flows.length > 0) {
  workspaces = flows.map((value) => `-w ${path.basename(value)}`).join(" ");
}

const projects = JSON.parse(
  execSync(`npm pkg get ${workspaces} name version module tedge`),
);

// create temp folder to used during packaging
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-builder"));

const outputDir = "./dist";
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

for (const [_, project] of Object.entries(projects)) {
  const sourceProjectDir = `flows/${project.name}`;
  const projectDir = `${tmpDir}/${project.name}`;
  console.log(
    `Copying files from '${sourceProjectDir}/' to '${projectDir}' (tmpdir)`,
  );
  fs.cpSync(sourceProjectDir, `${tmpDir}/${project.name}`, { recursive: true });
  const flowFile = path.join(projectDir, flowFilename);

  if (fs.existsSync(flowFile)) {
    // inject name and version into the flows.toml file
    const contents = fs.readFileSync(flowFile, { encoding: "utf-8" });
    fs.writeFileSync(
      flowFile,
      [
        `name = "${project.name}"`,
        `version = "${project.version || "0.0.0"}"\n`,
        contents,
      ].join("\n"),
    );

    // Which mapper the flow is designed for
    let mapper = "local";
    if (project.tedge && project.tedge.mapper) {
      mapper = project.tedge.mapper;
    }
    console.info("project:", project);

    // Create tar file with flow.toml and built module files, but replace '/' with %2F (url encoding)
    const tarFileName = mapper
      ? `${mapper}%2F${project.name}_${project.version}.tar.gz`
      : `${project.name}_${project.version}.tar.gz`;
    const tarFilePath = path.join(outputDir, tarFileName);
    console.log(`Creating tar file: ${tarFileName}`);

    execSync(
      `tar -czf ${tarFilePath} -C ${projectDir} ${flowFilename} ${project.module}`,
      { stdio: "inherit", env: { COPYFILE_DISABLE: 1 } },
    );

    console.log(`Created tar file at: ${tarFilePath}`);

    if (publishToRegistry) {
      const image = `${registry}/${owner}/${project.name}:${project.version}`;
      console.log(
        `\nPublishing flow. image=${image}, project=${project.name}, version=${project.version}, module=${project.module}`,
      );
      execSync(
        `tedge-oscar flows images push ${image} --file ${projectDir}/${project.module} --file ${projectDir}/${flowFilename} --root ${projectDir}`,
      );
    }
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });

process.exit(0);
