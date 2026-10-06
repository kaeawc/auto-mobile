import { expect, test } from "bun:test";
import { formatCommandError } from "../../src/utils/CommandError";

test("bounds overflow diagnostics and reports the untrimmed stdout byte count", () => {
  const stdout = `  ${"旗".repeat(400_000)}  `;
  const error = Object.assign(new Error(`stdout maxBuffer length exceeded\n${stdout}`), {
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    stdout: Buffer.from(stdout),
    stderr: "",
  });
  const message = formatCommandError(error, {
    command: "adb",
    args: ["shell", "dumpsys", "input_method"],
  });
  expect(message).toContain("error code: ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  expect(message).toContain(
    `stdout: (last 300 chars; ${Buffer.byteLength(stdout)} bytes; truncated)`,
  );
  expect(message).toContain("...[truncated]");
  const excerpt = message.split("; truncated)\n")[1];
  expect(excerpt.length).toBeLessThanOrEqual(300);
  expect(message.length).toBeLessThan(850);
  expect(message).not.toContain(stdout);
});

test("keeps short exit diagnostics and stderr intact", () => {
  expect(
    formatCommandError(Object.assign(new Error("permission denied"), { code: 1 }), {
      command: "adb",
      args: ["shell", "id"],
      stderr: "Permission denied\n",
    }),
  ).toBe(
    "Command failed: adb shell id\nexit code: 1\nraw error: (last 4000 chars) permission denied\nstderr: (last 4000 chars)\nPermission denied",
  );
});
