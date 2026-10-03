import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { ExecResult } from "../../../src/models";

const captured = readFileSync(
  join(import.meta.dir, "../../features/observe/activityActivitiesDumps/single-display-phone.log"),
  "utf8",
);
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

  for (const output of ["", "unparsable output"]) {
    test(`successful ${output ? "unparsable" : "empty"} read is known with no foreground`, async () => {
      const client = new StubAdbClient(() => output);
      expect(await client.getForegroundAppChecked()).toEqual({ state: "known", app: null });
      expect(await client.getForegroundApp()).toBeNull();
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
      state: "known",
      app: null,
    });
  });

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
