import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { resolveCliCommand } from "../../../scripts/ios/sdk-contract/run";

for (const args of [
  ["--debug", "--embedded-sdk", "--cli", "getApple", "--deviceId", "fake"],
  [
    "--debug",
    "--embedded-sdk",
    "--cli",
    "--session-uuid",
    "session",
    "observe",
    "--platform",
    "ios",
  ],
  ["--daemon", "release-session", "session"],
]) {
  test(`checkout CLI command preserves arguments: ${args.join(" ")}`, () => {
    const originalArgs = [...args];
    expect(resolveCliCommand(args, process.execPath)).toEqual({
      command: process.execPath,
      args: [fileURLToPath(new URL("../../../dist/src/index.js", import.meta.url)), ...args],
    });
    expect(args).toEqual(originalArgs);
  });
}
