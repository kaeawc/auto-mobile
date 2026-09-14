import { describe, expect, test } from "bun:test";
import { parseAndroidSystemImageRuntime } from "../../src/utils/android-cmdline-tools/AndroidSystemImageRuntime";

describe("parseAndroidSystemImageRuntime", () => {
  test.each([
    [
      "system-images;android-36;google_apis;x86_64",
      {
        apiLevel: 36,
        tag: "google_apis",
        architecture: "x86_64",
        systemImagePackage: "system-images;android-36;google_apis;x86_64",
      },
    ],
    [
      "system-images;android-36.1;google_apis_playstore;arm64-v8a",
      {
        apiLevel: 36,
        tag: "google_apis_playstore",
        architecture: "arm64",
        systemImagePackage: "system-images;android-36.1;google_apis_playstore;arm64-v8a",
      },
    ],
    [
      "system-images;android-35;custom_tag;riscv64",
      {
        apiLevel: 35,
        tag: "custom_tag",
        architecture: "riscv64",
        systemImagePackage: "system-images;android-35;custom_tag;riscv64",
      },
    ],
  ] as const)("parses exact package identity %s", (runtime, expected) => {
    expect(parseAndroidSystemImageRuntime(runtime)).toEqual(expected);
  });

  test.each([
    "",
    "platforms;android-36;google_apis;x86_64",
    "system-images;android-36;google_apis",
    "system-images;android-36;;x86_64",
    "system-images;android-36;google_apis;",
    "system-images;android-36-preview;google_apis;x86_64",
    "system-images;android-36.;google_apis;x86_64",
    "system-images;android-0;google_apis;x86_64",
    "system-images;android-999999999999999999999;google_apis;x86_64",
    "system-images;android-36.999999999999999999999;google_apis;x86_64",
  ])("rejects invalid package identity %s", (runtime) => {
    expect(parseAndroidSystemImageRuntime(runtime)).toBeUndefined();
  });
});
