import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  oldestSupportedProtoViewerRelease,
  PROTOVIEWER_OLDEST_SUPPORTED,
  protoViewerSupportWindowWarning,
  protoViewerVersionCode,
} from "../../../../src/features/prototype/protoViewer/protoViewerSupportWindow";

// Shared with the Gradle ProtoViewerVersioningTest, which derives the same codes.
const VECTORS = readFileSync(
  join(import.meta.dir, "../../../fixtures/protoviewer-version-codes.txt"),
  "utf8",
)
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"))
  .map((line) => line.split(/\s+/));

describe("ProtoViewer versionCode", () => {
  test("matches the shared vectors the Gradle derivation also checks", () => {
    expect(VECTORS.length).toBeGreaterThan(0);
    for (const [version, expected] of VECTORS) {
      const code = protoViewerVersionCode(version);
      expect({ version, code }).toEqual({
        version,
        code: expected === "invalid" ? undefined : Number(expected),
      });
    }
  });
});

describe("oldest supported ProtoViewer release", () => {
  const apk = "a".repeat(64);
  test("is the third newest release that ships the APK", () => {
    expect(
      oldestSupportedProtoViewerRelease([
        { version: "0.0.96", protoViewerApkSha256: apk },
        { version: "0.0.95" },
        { version: "0.0.94", protoViewerApkSha256: apk },
        { version: "0.0.93", protoViewerApkSha256: apk },
        { version: "0.0.92", protoViewerApkSha256: apk },
      ]),
    ).toEqual({ version: "0.0.93", versionCode: 93 });
  });

  test("orders by version, not registry position, and skips unparsable versions", () => {
    expect(
      oldestSupportedProtoViewerRelease([
        { version: "0.0.92", protoViewerApkSha256: apk },
        { version: "0.1.0", protoViewerApkSha256: apk },
        { version: "nightly", protoViewerApkSha256: apk },
        { version: "0.0.100", protoViewerApkSha256: apk },
        { version: "0.0.99", protoViewerApkSha256: "" },
      ]),
    ).toEqual({ version: "0.0.92", versionCode: 92 });
  });

  test("is the oldest shipped release while fewer than three have shipped, and none before", () => {
    expect(
      oldestSupportedProtoViewerRelease([
        { version: "0.0.95", protoViewerApkSha256: apk },
        { version: "0.0.94", protoViewerApkSha256: apk },
      ]),
    ).toEqual({ version: "0.0.94", versionCode: 94 });
    expect(oldestSupportedProtoViewerRelease([{ version: "0.0.95" }])).toBeUndefined();
  });

  test("the registry yields a window", () => {
    expect(PROTOVIEWER_OLDEST_SUPPORTED?.versionCode).toBeGreaterThan(1);
  });
});

describe("support-window warning", () => {
  const oldest = { version: "0.0.93", versionCode: 93 };
  test("names the installed build, the oldest supported release and the update link", () => {
    expect(
      protoViewerSupportWindowWarning(
        { versionCode: 90, version: "0.0.90", updateUrl: "https://example.test/pv" },
        oldest,
      ),
    ).toBe(
      "The installed ProtoViewer (0.0.90) is older than the oldest supported release (0.0.93); this host supports the last 3 releases. Update ProtoViewer from https://example.test/pv.",
    );
    expect(protoViewerSupportWindowWarning({ versionCode: 90 }, oldest)).toBe(
      "The installed ProtoViewer (versionCode 90) is older than the oldest supported release (0.0.93); this host supports the last 3 releases. Update ProtoViewer.",
    );
  });

  test("stays quiet inside the window, for local builds and for unknown versions", () => {
    expect(protoViewerSupportWindowWarning({ versionCode: 93 }, oldest)).toBeUndefined();
    expect(protoViewerSupportWindowWarning({ versionCode: 1 }, oldest)).toBeUndefined();
    expect(protoViewerSupportWindowWarning({}, oldest)).toBeUndefined();
    expect(protoViewerSupportWindowWarning({ versionCode: 90 }, undefined)).toBeUndefined();
  });
});
