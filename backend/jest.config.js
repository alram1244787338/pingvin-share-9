/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  rootDir: ".",
  roots: ["<rootDir>/src"],
  testRegex: ".*\\.spec\\.ts$",
  // Decorated classes emit `Reflect.metadata(...)` calls, which need the
  // reflect-metadata polyfill to be present before any of them is loaded.
  setupFiles: ["reflect-metadata"],
  moduleFileExtensions: ["ts", "js", "json"],
  // Mirrors the `baseUrl: "./"` path resolution from tsconfig.json so that
  // `import ... from "src/..."` resolves the same way it does in the app.
  moduleNameMapper: {
    "^src/(.*)$": "<rootDir>/src/$1",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.json",
      },
    ],
  },
};
