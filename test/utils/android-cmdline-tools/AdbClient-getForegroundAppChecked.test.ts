import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { ExecResult } from "../../../src/models";

const captured = readFileSync(
  join(import.meta.dir, "../../features/observe/activityActivitiesDumps/single-display-phone.log"),
  "utf8",
);
const multiDisplay = readFileSync(
  join(
    import.meta.dir,
    "../../features/observe/activityActivitiesDumps/multi-display-foldable.log",
  ),
  "utf8",
);
const withoutResumed = captured
  .split(/\r?\n/)
  .filter(
    (line) =>
      !/\b(topResumedActivity|mResumedActivity|ResumedActivity|Resumed|mFocusedActivity)\b/.test(
        line,
      ),
  )
  .join("\n");
const result = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value) => stdout.includes(value),
});
class StubAdbClient extends AdbClient {
  calls: Array<{ timeout?: number; signal?: AbortSignal }> = [];
  constructor(private readonly read: (signal?: AbortSignal) => string | Promise<string>) {
    super(null);
  }
  override async executeCommand(
    _command: string,
    timeout?: number,
    _maxBuffer?: number,
    _noRetry?: boolean,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    this.calls.push({ timeout, signal });
    return result(await this.read(signal));
  }
}

describe("AdbClient.getForegroundAppChecked", () => {
  test("command failure is unreadable while the legacy wrapper returns null", async () => {
    const client = new StubAdbClient(() => {
      throw new Error("device offline");
    });
    expect(await client.getForegroundAppChecked()).toEqual({
      state: "unreadable",
      error: "device offline",
    });
    expect(await client.getForegroundApp()).toBeNull();
  });

  // No capture positively identifies an empty foreground, so known/app:null has no reader fixture.
  for (const { name, output, displayId, displayCount } of [
    { name: "empty output", output: "", displayId: 0, displayCount: 0 },
    { name: "unrecognised output", output: "unparsable output", displayId: 0, displayCount: 0 },
    {
      name: "captured display without resumed lines",
      output: withoutResumed,
      displayId: 0,
      displayCount: 1,
    },
    { name: "missing foldable display", output: multiDisplay, displayId: 1, displayCount: 2 },
  ]) {
    test(`${name} is unreadable while the legacy wrapper returns null`, async () => {
      const client = new StubAdbClient(() => output);
      const read = await client.getForegroundAppChecked(undefined, { displayId });
      expect(read.state).toBe("unreadable");
      if (read.state !== "unreadable") {
        throw new Error("Expected unreadable foreground state");
      }
      expect(read.error).toContain(
        "No resumed activity could be parsed from the dumpsys activity activities output",
      );
      expect(read.error).toContain(`display ${displayId}`);
      expect(read.error).toContain(`display sections: ${displayCount}`);
      expect(read.error).toContain(`stdout length: ${output.length}`);
      if (output) {
        expect(read.error).not.toContain(output);
      }
      expect(await client.getForegroundApp(undefined, { displayId })).toBeNull();
    });
  }

  test("captured activity returns known identity and preserves legacy output and read options", async () => {
    const client = new StubAdbClient(() => captured);
    const signal = new AbortController().signal;
    const expected = {
      packageName: "com.android.contacts",
      userId: 0,
      activityName: "com.android.contacts.activities.PeopleActivity",
      displayCount: 1,
    };
    expect(await client.getForegroundAppChecked(signal, 123)).toEqual({
      state: "known",
      app: expected,
    });
    expect(client.calls[0]).toEqual({ timeout: 123, signal });
    expect(await client.getForegroundApp()).toEqual(expected);
    expect(await client.getForegroundAppChecked(undefined, { displayId: 2 })).toEqual({
      state: "unreadable",
      error: `No resumed activity could be parsed from the dumpsys activity activities output for display 2 (display sections: 1, stdout length: ${captured.length})`,
    });
  });

  for (const [displayId, packageName] of [
    [0, "com.google.android.gms"],
    [2, "com.android.settings"],
  ] as const) {
    test(`captured foldable display ${displayId} returns its resumed app`, async () => {
      const client = new StubAdbClient(() => multiDisplay);
      expect(await client.getForegroundAppChecked(undefined, { displayId })).toMatchObject({
        state: "known",
        app: { packageName, userId: 0, displayCount: 2 },
      });
    });
  }

  for (const method of ["getForegroundAppChecked", "getForegroundApp"] as const) {
    test(`${method} rethrows cancellation during a failed read`, async () => {
      const controller = new AbortController();
      const reason = new Error("request cancelled");
      const client = new StubAdbClient(() => {
        controller.abort(reason);
        throw new Error("command interrupted");
      });
      await expect(client[method](controller.signal)).rejects.toThrow(reason);
    });
  }
});
