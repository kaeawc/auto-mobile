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

  test("decodes split UTF-8 before redacting and flushes incomplete bytes", () => {
    const redactor = new AndroidCommandOutputStreamRedactor();
    const output =
      redactor.append(Buffer.from([0x78, 0x20, 0x74, 0x6f, 0x6b, 0x65, 0x6e, 0xc2])) +
      redactor.append(Buffer.from([0xa0, 0x3d, ...Buffer.from("SECRETVALUE\n")])) +
      redactor.flush();
    expect(output).toContain("token=[REDACTED]");
    expect(output).not.toContain("SECRETVALUE");
    expect(output).not.toContain("�");

    for (const value of ["😀", "€"]) {
      const bytes = Buffer.from(value);
      const split = new AndroidCommandOutputStreamRedactor();
      let roundTrip = "";
      for (const byte of bytes) roundTrip += split.append(Buffer.from([byte]));
      roundTrip += split.flush();
      expect(roundTrip).toBe(value);
    }
    const trailing = new AndroidCommandOutputStreamRedactor();
    trailing.append(Buffer.from([0xe2, 0x82]));
    expect(trailing.flush()).toBe("�");
  });
});
