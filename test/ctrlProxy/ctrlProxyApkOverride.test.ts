import { describe, expect, test } from "bun:test";
import {
  assertCtrlProxyApkOverrideUsable,
  readableFileProbe,
  resolveCtrlProxyApkPathOverride,
  type CtrlProxyApkOverrideProbe,
} from "../../src/ctrlProxy/ctrlProxyApkOverride";
import { ActionableError } from "../../src/models/ActionableError";
import { chmod, mkdtemp, open, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";

const missing: CtrlProxyApkOverrideProbe = {
  stat: async (filePath) => {
    throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${filePath}'`), {
      code: "ENOENT",
    });
  },
};
const entry = (isFile: boolean): CtrlProxyApkOverrideProbe => ({
  stat: async () => ({ isFile: () => isFile }),
});

describe("assertCtrlProxyApkOverrideUsable", () => {
  test("names the env var and path when the override file is missing", async () => {
    const error = await assertCtrlProxyApkOverrideUsable("/gone/control-proxy.apk", missing).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ActionableError);
    const message = (error as ActionableError).message;
    expect(message).toContain("AUTOMOBILE_CTRL_PROXY_APK_PATH");
    expect(message).toContain("/gone/control-proxy.apk");
    expect(message).not.toContain("Failed to download APK");
  });

  test("rejects an override that is not a file", async () => {
    await expect(assertCtrlProxyApkOverrideUsable("/some/dir", entry(false))).rejects.toThrow(
      /AUTOMOBILE_CTRL_PROXY_APK_PATH points to \/some\/dir, which is not a file/,
    );
  });

  test("accepts an existing file", async () => {
    await assertCtrlProxyApkOverrideUsable("/ok.apk", entry(true));
  });
});

describe("resolveCtrlProxyApkPathOverride", () => {
  test("is null when unset or blank", () => {
    expect(resolveCtrlProxyApkPathOverride({})).toBeNull();
    expect(resolveCtrlProxyApkPathOverride({ AUTOMOBILE_CTRL_PROXY_APK_PATH: "  " })).toBeNull();
  });

  test("returns an absolute override unchanged", () => {
    expect(
      resolveCtrlProxyApkPathOverride({ AUTOMOBILE_CTRL_PROXY_APK_PATH: " /abs/a.apk " }),
    ).toBe("/abs/a.apk");
  });
});

describe("readableFileProbe", () => {
  test("refuses a file whose metadata is visible but which cannot be opened for reading", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apk-override-"));
    const apk = path.join(dir, "control-proxy-debug.apk");
    try {
      await writeFile(apk, "apk");
      await chmod(apk, 0o000);
      const openable = await open(apk, "r").then(
        async (handle) => {
          await handle.close();
          return true;
        },
        () => false,
      );
      // Root and Windows can open a mode-000 file, so there it must pass instead.
      const check = assertCtrlProxyApkOverrideUsable(apk, readableFileProbe);
      if (openable) {
        await check;
      } else {
        await expect(check).rejects.toThrow(`${apk}, which cannot be read (`);
      }
    } finally {
      await chmod(apk, 0o600);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports the type of a file it can open", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apk-override-"));
    try {
      await writeFile(path.join(dir, "a.apk"), "apk");
      expect((await readableFileProbe.stat(path.join(dir, "a.apk"))).isFile()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
