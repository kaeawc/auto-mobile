import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  resolveAndroidAutoProvisionInputs,
  type AndroidAutoHostFiles,
} from "../../../src/features/androidAuto/androidAutoProvisionInputs";
import { ActionableError } from "../../../src/models/ActionableError";

const SDK = path.resolve("/sdk");
const APK_DIR = path.resolve("/apks");
const DHU = path.join(SDK, "extras", "google", "auto", "desktop-head-unit");
const CONFIG = path.join(SDK, "extras", "google", "auto", "config", "default_720p.ini");

/** A host filesystem of plain sets: directories with their listings, and files. */
function hostFiles(directories: Record<string, string[]>, files: string[]): AndroidAutoHostFiles {
  return {
    isDirectory: async (target) => target in directories,
    isFile: async (target) => files.includes(target),
    list: async (directory) => directories[directory] ?? [],
  };
}

const COMPLETE = hostFiles(
  {
    [APK_DIR]: [
      "split_config.xxhdpi.apk",
      "base.apk",
      "split_config.arm64_v8a.apk",
      "notes.txt",
      "split_config.en.apk",
    ],
  },
  [DHU, CONFIG],
);

function resolve(files: AndroidAutoHostFiles, overrides: Record<string, unknown> = {}, env = {}) {
  return resolveAndroidAutoProvisionInputs(
    { apkDirectory: APK_DIR, ...overrides },
    { env: { ANDROID_HOME: SDK, ...env }, platform: "linux", files },
  );
}

describe("resolveAndroidAutoProvisionInputs", () => {
  test("lists base.apk first and every split, and finds the SDK's DHU and default config", async () => {
    const inputs = await resolve(COMPLETE, { acceptAndroidAutoTerms: true });
    expect(inputs.androidAutoApks).toEqual(
      [
        "base.apk",
        "split_config.arm64_v8a.apk",
        "split_config.en.apk",
        "split_config.xxhdpi.apk",
      ].map((name) => path.join(APK_DIR, name)),
    );
    expect(inputs.dhu).toEqual({ binaryPath: DHU, configPath: CONFIG });
    expect(inputs.acceptAndroidAutoTerms).toBe(true);
  });

  test("a missing APK directory is an actionable error naming it", async () => {
    const refused = resolve(hostFiles({}, [DHU, CONFIG]));
    await expect(refused).rejects.toBeInstanceOf(ActionableError);
    await expect(refused).rejects.toThrow(
      `the Android Auto APK directory ${APK_DIR} does not exist`,
    );
  });

  test("a directory without base.apk is refused", async () => {
    await expect(
      resolve(hostFiles({ [APK_DIR]: ["split_config.en.apk"] }, [DHU, CONFIG])),
    ).rejects.toThrow(`${APK_DIR} has no base.apk`);
  });

  test("a missing DHU names its path and the SDK package, once", async () => {
    const refused = resolve(hostFiles({ [APK_DIR]: ["base.apk"] }, []));
    await expect(refused).rejects.toThrow(`the Desktop Head Unit at ${DHU}`);
    await expect(refused).rejects.toThrow('sdkmanager "extras;google;auto"');
    await expect(refused).rejects.not.toThrow("head unit config");
  });

  test("names every missing piece in one error", async () => {
    await expect(resolve(hostFiles({}, []))).rejects.toThrow(
      /APK directory .* does not exist.*; and the Desktop Head Unit at/,
    );
  });

  test("without ANDROID_HOME the DHU must be passed explicitly", async () => {
    await expect(
      resolveAndroidAutoProvisionInputs(
        { apkDirectory: APK_DIR },
        { env: {}, platform: "linux", files: COMPLETE },
      ),
    ).rejects.toThrow("ANDROID_HOME is not set");
  });

  test("an explicit DHU and config are used and checked", async () => {
    const dhu = path.resolve("/opt/dhu/desktop-head-unit");
    const config = path.resolve("/opt/dhu/cluster.ini");
    const files = hostFiles({ [APK_DIR]: ["base.apk"] }, [dhu]);
    await expect(resolve(files, { dhuPath: dhu, dhuConfig: config })).rejects.toThrow(
      `the head unit config ${config}`,
    );
    const inputs = await resolve(hostFiles({ [APK_DIR]: ["base.apk"] }, [dhu, config]), {
      dhuPath: dhu,
      dhuConfig: config,
    });
    expect(inputs.dhu).toEqual({ binaryPath: dhu, configPath: config });
  });

  test("looks for the Windows DHU binary on Windows", async () => {
    await expect(
      resolveAndroidAutoProvisionInputs(
        { apkDirectory: APK_DIR },
        { env: { ANDROID_HOME: SDK }, platform: "win32", files: COMPLETE },
      ),
    ).rejects.toThrow("desktop-head-unit.exe");
  });
});
