const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const flowFilename = "flow.toml";
const registry = process.env.REGISTRY || "ghcr.io";
const owner = process.env.OWNER || "thin-edge";

let workspaces = "--workspaces";
if (process.argv.length > 2) {
  workspaces = process.argv
    .slice(2)
    .map((value) => `-w ${path.basename(value)}`)
    .join(" ");
}

const projects = JSON.parse(
  execSync(`npm pkg get ${workspaces} name version module`),
);

// create temp folder to used during packaging
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-builder"));

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
        `# name = "${project.name}"`,
        `# version = "${project.version || "0.0.0"}"\n`,
        contents,
      ].join("\n"),
    );

    const image = `${registry}/${owner}/${project.name}:${project.version}`;
    console.log(
      `\nPublishing flow. project=${project.name}, version=${project.version}, module=${project.module}`,
    );
    execSync(
      `tedge-oscar flows images push ${image} --file ${projectDir}/${project.module} --file ${projectDir}/${flowFilename} --root ${projectDir}`,
    );
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });

process.exit(0);
