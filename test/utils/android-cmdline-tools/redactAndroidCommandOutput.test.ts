import { describe, expect, test } from "bun:test";
import { redactAndroidCommandOutput } from "../../../src/utils/android-cmdline-tools/redactAndroidCommandOutput";

describe("redactAndroidCommandOutput", () => {
  test("redacts credential assignments and home-directory paths", () => {
    const output = redactAndroidCommandOutput(
      "token=super-secret password: hunter2 api_key=abc123 /Users/tester/.android/avd/Pixel_9_Pro.avd",
      "/Users/tester",
    );

    expect(output).toBe(
      "token=[REDACTED] password=[REDACTED] api_key=[REDACTED] ~/.android/avd/Pixel_9_Pro.avd",
    );
  });
});
