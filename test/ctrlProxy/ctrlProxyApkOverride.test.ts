import { describe, expect, test } from "bun:test";
import * as path from "path";
import { chmod, mkdtemp, open, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import {
  assertCtrlProxyApkOverrideUsable,
  CtrlProxyApkOverrideUnusableError,
  preflightCtrlProxyApkOverride,
  resolveCtrlProxyApkPathOverride,
  statReadableFile,
  type ApkOverrideStat,
} from "../../src/ctrlProxy/ctrlProxyApkOverride";
import { ActionableError } from "../../src/models/ActionableError";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";

const STALE = "/work/.claude/worktrees/lane-r/control-proxy-debug.apk";

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), {
    code: "ENOENT",
  });
}

function fakeStat(entries: Record<string, "file" | "dir">): ApkOverrideStat & { calls: string[] } {
  const calls: string[] = [];
  const stat = async (path: string) => {
    calls.push(path);
    const kind = entries[path];
    if (!kind) {
      throw enoent(path);
    }
    return { isFile: () => kind === "file" };
  };
  return Object.assign(stat, { calls });
}

describe("resolveCtrlProxyApkPathOverride", () => {
  test("unset or blank is no override", () => {
    expect(resolveCtrlProxyApkPathOverride({})).toBeNull();
    expect(resolveCtrlProxyApkPathOverride({ AUTOMOBILE_CTRL_PROXY_APK_PATH: "  " })).toBeNull();
  });

  test("a relative path resolves against the daemon launch directory", () => {
    expect(
      resolveCtrlProxyApkPathOverride({
        AUTOMOBILE_CTRL_PROXY_APK_PATH: " build/app.apk ",
        [DAEMON_LAUNCH_CWD_ENV]: "/launch",
      }),
    ).toBe(path.resolve("/launch", "build/app.apk"));
  });
});

describe("assertCtrlProxyApkOverrideUsable", () => {
  test("a missing file names the variable, the path and the consequence", async () => {
    const error = await assertCtrlProxyApkOverrideUsable(
      STALE,
      fakeStat({}),
      "No device was booted.",
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CtrlProxyApkOverrideUnusableError);
    expect(error).toBeInstanceOf(ActionableError);
    const message = (error as Error).message;
    expect(message).toContain(
      `AUTOMOBILE_CTRL_PROXY_APK_PATH points at ${STALE}, which does not exist.`,
    );
    expect(message).toContain("No device was booted.");
    expect(message).toContain("unset it and restart the daemon");
    expect(message).not.toContain("download");
  });

  test("a directory is refused as not a file", async () => {
    await expect(
      assertCtrlProxyApkOverrideUsable(STALE, fakeStat({ [STALE]: "dir" }), "x."),
    ).rejects.toThrow(`${STALE}, which is not a file.`);
  });

  test("an unreadable path reports the stat error", async () => {
    const stat: ApkOverrideStat = async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    await expect(assertCtrlProxyApkOverrideUsable(STALE, stat, "x.")).rejects.toThrow(
      "cannot be read (EACCES: permission denied)",
    );
  });

  test("an existing file passes", async () => {
    await assertCtrlProxyApkOverrideUsable(STALE, fakeStat({ [STALE]: "file" }), "x.");
  });
});

describe("statReadableFile", () => {
  test("refuses a file whose metadata is visible but which cannot be opened for reading", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apk-override-"));
    const apk = path.join(dir, "control-proxy-debug.apk");
    try {
      await writeFile(apk, "apk");
      await chmod(apk, 0o000);
      const readable = await open(apk, "r").then(
        async (handle) => {
          await handle.close();
          return true;
        },
        () => false,
      );
      // Root (and Windows) can open a mode-000 file; there the case does not arise.
      if (readable) {
        await assertCtrlProxyApkOverrideUsable(apk, statReadableFile, "x.");
        return;
      }
      await expect(assertCtrlProxyApkOverrideUsable(apk, statReadableFile, "x.")).rejects.toThrow(
        `${apk}, which cannot be read (`,
      );
    } finally {
      await chmod(apk, 0o600);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports an open file's type", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apk-override-"));
    try {
      await writeFile(path.join(dir, "a.apk"), "apk");
      expect((await statReadableFile(path.join(dir, "a.apk"))).isFile()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("preflightCtrlProxyApkOverride", () => {
  test("does nothing without an override", async () => {
    const stat = fakeStat({});
    await preflightCtrlProxyApkOverride({}, stat);
    expect(stat.calls).toEqual([]);
  });

  test("refuses a stale override before any device is booted", async () => {
    await expect(
      preflightCtrlProxyApkOverride({ AUTOMOBILE_CTRL_PROXY_APK_PATH: STALE }, fakeStat({})),
    ).rejects.toThrow(/does not exist\. No device was booted\./);
  });
});
