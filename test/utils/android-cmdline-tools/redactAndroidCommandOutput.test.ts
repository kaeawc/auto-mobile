import { describe, expect, test } from "bun:test";
import {
  AndroidCommandOutputStreamRedactor,
  redactAndroidCommandOutput,
} from "../../../src/utils/android-cmdline-tools/redactAndroidCommandOutput";

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

  test("redacts quoted and prefixed credential assignments", () => {
    const output = redactAndroidCommandOutput(
      "access_token=\"secret value\" client_secret='another secret' auth.api-key=abc123",
    );

    expect(output).toBe("access_token=[REDACTED] client_secret=[REDACTED] auth.api-key=[REDACTED]");
  });

  test("preserves redaction across chunk and quoted-line boundaries", () => {
    const redactor = new AndroidCommandOutputStreamRedactor();
    const output = [
      redactor.append('token="redaction'),
      redactor.append('-canary\nsecret-tail" diagnostic'),
      redactor.flush(),
    ].join("");

    expect(output).toBe("token=[REDACTED] diagnostic");
    expect(output).not.toContain("redaction-canary");
    expect(output).not.toContain("secret-tail");
  });

  test("preserves quoted escape state across chunk boundaries", () => {
    const redactor = new AndroidCommandOutputStreamRedactor();
    const output = [
      redactor.append('token="value\\'),
      redactor.append('"secret-tail" diagnostic'),
      redactor.flush(),
    ].join("");

    expect(output).toBe("token=[REDACTED] diagnostic");
    expect(output).not.toContain("secret-tail");
  });
});
