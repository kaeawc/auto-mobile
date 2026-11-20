import { describe, expect, test } from "bun:test";
import {
  assertCtrlProxyApkOverrideUsable,
  resolveCtrlProxyApkPathOverride,
  type CtrlProxyApkOverrideProbe,
} from "../../src/ctrlProxy/ctrlProxyApkOverride";
import { ActionableError } from "../../src/models/ActionableError";

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
