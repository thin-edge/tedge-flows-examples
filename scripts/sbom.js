const { execSync } = require("child_process");
const options = {
  stdio: "inherit",
};
try {
  execSync("trivy --version", options);
} catch (error) {
  console.error("trivy binary not found. Please install trivy.");
  process.exit(1);
}

const includeDevDepends = false;

execSync(
  `trivy fs . --include-dev-deps=${includeDevDepends} --scanners vuln --format cyclonedx --output sbom.cyclonedx.json`,
  options,
);
execSync(
  `trivy fs . --include-dev-deps=${includeDevDepends} --scanners vuln --format spdx-json --output sbom.spdx.json`,
  options,
);
execSync(`trivy fs . --include-dev-deps=${includeDevDepends}`, options);
process.exit(0);
