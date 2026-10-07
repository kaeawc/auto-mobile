import { describe, expect, test } from "bun:test";
import {
  currentProcessEntrypoint,
  isBunTestRunnerProcess,
} from "../../src/utils/bunTestRunnerProcess";

describe("isBunTestRunnerProcess (#10486)", () => {
  test("armed for NODE_ENV=test with a test-file entrypoint", () => {
    expect(isBunTestRunnerProcess({ NODE_ENV: "test" }, "/repo/test/db/foo.test.ts")).toBe(true);
    expect(isBunTestRunnerProcess({ NODE_ENV: "test" }, "/repo/test/foo.spec.mjs")).toBe(true);
  });

  test("not armed in a spawned CLI/daemon child that inherited NODE_ENV=test", () => {
    expect(isBunTestRunnerProcess({ NODE_ENV: "test" }, "/repo/dist/src/index.js")).toBe(false);
    expect(isBunTestRunnerProcess({ NODE_ENV: "test" }, "/repo/src/index.ts")).toBe(false);
  });

  test("not armed without an entrypoint", () => {
    expect(isBunTestRunnerProcess({ NODE_ENV: "test" }, undefined)).toBe(false);
  });

  test("not armed when NODE_ENV is not exactly test", () => {
    const entry = "/repo/test/db/foo.test.ts";
    expect(isBunTestRunnerProcess({ NODE_ENV: "production" }, entry)).toBe(false);
    expect(isBunTestRunnerProcess({ NODE_ENV: "" }, entry)).toBe(false);
    expect(isBunTestRunnerProcess({}, entry)).toBe(false);
  });

  test("defaults to the live process: this very test file is the entrypoint", () => {
    expect(currentProcessEntrypoint()).toMatch(/\.test\.ts$/);
    expect(isBunTestRunnerProcess(process.env, currentProcessEntrypoint())).toBe(true);
  });
});
