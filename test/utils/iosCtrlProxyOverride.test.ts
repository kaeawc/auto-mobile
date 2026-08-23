import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import {
  getIosCtrlProxyOverrideRaw,
  hasIosCtrlProxyOverride,
  checkIosCtrlProxyOverride,
} from "../../src/utils/iosCtrlProxyOverride";

describe("iosCtrlProxyOverride (#4221)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ios-override-test-"));
  });
  afterEach(async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const env = (o: Record<string, string | undefined>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

  // A real CtrlProxy .ipa is a zip over 10KB. The helper validates zip magic +
  // size (#4221 review), so fixtures must be genuine, not one byte.
  function ipaBytes(): Buffer {
    const head = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
    return Buffer.concat([head, Buffer.alloc(11_000)]);
  }

  test("reports no override when neither var is set", () => {
    expect(getIosCtrlProxyOverrideRaw(env({}))).toBeNull();
    expect(hasIosCtrlProxyOverride(env({}))).toBe(false);
  });

  test("IPA_PATH wins over BUNDLE_PATH", () => {
    expect(
      getIosCtrlProxyOverrideRaw(
        env({
          AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH: "/a.ipa",
          AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH: "/b",
        }),
      ),
    ).toBe("/a.ipa");
  });

  test("a real .ipa file is usable", async () => {
    const ipa = path.join(dir, "runner.ipa");
    await fs.writeFile(ipa, ipaBytes());
    const result = await checkIosCtrlProxyOverride(
      env({ AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH: ipa }),
    );
    expect(result).toMatchObject({ present: true, usable: true, path: ipa });
  });

  test("a directory is present but not usable, and says why", async () => {
    const result = await checkIosCtrlProxyOverride(
      env({ AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH: dir }),
    );
    expect(result.present).toBe(true);
    expect(result.usable).toBe(false);
    expect(result.reason).toContain("directory");
    expect(result.reason).toContain("AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA");
  });

  test("a non-existent path is present but not usable", async () => {
    const result = await checkIosCtrlProxyOverride(
      env({
        AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH: path.join(dir, "nope.ipa"),
      }),
    );
    expect(result.present).toBe(true);
    expect(result.usable).toBe(false);
    expect(result.reason).toContain("does not exist");
  });

  test("no override resolves to present:false", async () => {
    const result = await checkIosCtrlProxyOverride(env({}));
    expect(result).toMatchObject({ present: false, usable: false, path: null });
  });

  test("an existing file that is not a zip/ipa is present but not usable (#4221 review)", async () => {
    const notABundle = path.join(dir, "hosts");
    await fs.writeFile(notABundle, "127.0.0.1 localhost\n");
    const result = await checkIosCtrlProxyOverride(
      env({ AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH: notABundle }),
    );
    expect(result.present).toBe(true);
    expect(result.usable).toBe(false);
    expect(result.reason).toContain("not a runnable .ipa bundle");
  });

  test("a zip that is too small is not usable (#4221 review)", async () => {
    const tiny = path.join(dir, "tiny.ipa");
    await fs.writeFile(tiny, Buffer.from([0x50, 0x4b, 0x03, 0x04])); // valid magic, 4 bytes
    const result = await checkIosCtrlProxyOverride(
      env({ AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH: tiny }),
    );
    expect(result.usable).toBe(false);
  });
});
