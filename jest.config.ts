/** @jest-config-loader esbuild-register */
import type { Config } from "jest";

const esbuildOptions = {
  target: "es2018",
};

const config: Config = {
  verbose: true,
  transform: { "^.+\\.[tj]s?$": ["jest-esbuild", esbuildOptions] },
  testEnvironment: "node",
  moduleNameMapper: {
    "^@project/(.*)$": "./flows/$1/src", // Example:  maps @project/package-a to packages/package-a/src
  },
  testRegex: "/tests/.*\\.(test|spec)?\\.(ts|tsx)$",
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  transformIgnorePatterns: ["node_modules/(?!@noble/)"],
  coverageReporters: ["clover", "json", "lcov", ["text", { skipFull: true }]],
};

export default config;
