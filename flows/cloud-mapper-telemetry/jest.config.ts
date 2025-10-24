/** @jest-config-loader esbuild-register */
import type { Config } from "jest";

const esbuildOptions = {
  target: "es2018",
  // ignore labels for test coverage
  dropLabels: ["TEST", "DEV"],
};

const config: Config = {
  verbose: true,
  transform: { "^.+\\.ts?$": ["jest-esbuild", esbuildOptions] },
  testEnvironment: "node",
  testRegex: "/tests/.*\\.(test|spec)?\\.(ts|tsx)$",
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  coverageReporters: ["clover", "json", "lcov", ["text", { skipFull: true }]],
};

export default config;
