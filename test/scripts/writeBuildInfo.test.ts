import { describe, expect, test } from "bun:test";
import { collectBuildInfo, type BuildInfoPorts } from "../../scripts/release/write-build-info";
import type { ReleaseChecksumEntry } from "../../src/constants/release";

const sha = "a".repeat(40);
const release: ReleaseChecksumEntry = {
  version: "1.2.3",
  apkSha256: "1".repeat(64),
  ipaSha256: "",
  runnerSha256: "2".repeat(64),
  runnerSha256Target: "xctest",
};
const nightly: ReleaseChecksumEntry = { ...release, version: "nightly", apkSha256: "3".repeat(64) };
function ports(overrides: Partial<BuildInfoPorts> = {}): BuildInfoPorts {
  return {
    readPackageJson: () => ({ name: "@kaeawc/auto-mobile", version: "1.2.3" }),
    git: (args) => ({ exitCode: 0, stdout: args[0] === "rev-parse" ? sha : "" }),
    env: {},
    registry: [release],
    nightly,
    ...overrides,
  };
}
describe("collectBuildInfo", () => {
  test("records clean git identity and only non-empty checksum fields for the exact release", () => {
    expect(collectBuildInfo(ports())).toEqual({
      schemaVersion: 1,
      name: "@kaeawc/auto-mobile",
      version: "1.2.3",
      sourceSha: sha,
      sourceShaFrom: "git",
      sourceDirty: false,
      sourceDirtyPaths: [],
      nativeResources: { apkSha256: release.apkSha256, runnerSha256: release.runnerSha256 },
      nativeResourcesFrom: "release-registry",
    });
  });
  test("falls back to GITHUB_SHA when git is unavailable", () => {
    const result = collectBuildInfo(
      ports({ git: () => ({ exitCode: 1, stdout: "" }), env: { GITHUB_SHA: sha.toUpperCase() } }),
    );
    expect(result.sourceSha).toBe(sha);
    expect(result.sourceShaFrom).toBe("env");
    expect(result.sourceDirty).toBeNull();
    expect(result.sourceDirtyPaths).toBeNull();
  });
  test("records null provenance without git or valid environment SHA", () => {
    for (const env of [{}, { GITHUB_SHA: "invalid" }]) {
      const result = collectBuildInfo(ports({ git: () => ({ exitCode: 1, stdout: "" }), env }));
      expect(result.sourceSha).toBeNull();
      expect(result.sourceShaFrom).toBeNull();
      expect(result.sourceDirty).toBeNull();
    }
  });
  test("uses nightly for unreleased versions", () => {
    const result = collectBuildInfo(
      ports({ readPackageJson: () => ({ name: "@kaeawc/auto-mobile", version: "9.0.0" }) }),
    );
    expect(result.nativeResources?.apkSha256).toBe(nightly.apkSha256);
    expect(result.nativeResourcesFrom).toBe("nightly");
  });
  test("records tracked dirtiness using the untracked-files=no probe", () => {
    const calls: Array<readonly string[]> = [];
    const result = collectBuildInfo(
      ports({
        git: (args) => {
          calls.push(args);
          return { exitCode: 0, stdout: args[0] === "rev-parse" ? sha : " M package.json\0" };
        },
      }),
    );
    expect(result.sourceDirty).toBe(true);
    expect(result.sourceDirtyPaths).toEqual(["package.json"]);
    expect(calls[1]).toEqual(["status", "--porcelain", "-z", "--untracked-files=no"]);
  });
  test("emits exactly the BuildInfo keys even when package JSON contains private fields", () => {
    const result = collectBuildInfo(
      ports({
        readPackageJson: () => ({
          name: "@kaeawc/auto-mobile",
          version: "1.2.3",
          scripts: { test: "bun test" },
          contributors: [{ email: "private@example.test" }],
          dependencies: {},
        }),
      }),
    );
    expect(Object.keys(result).sort()).toEqual(
      [
        "schemaVersion",
        "name",
        "version",
        "sourceSha",
        "sourceShaFrom",
        "sourceDirty",
        "sourceDirtyPaths",
        "nativeResources",
        "nativeResourcesFrom",
      ].sort(),
    );
  });
  test("ignores exactly the README publish rewrite, preserving other tracked paths", () => {
    let status = " M README.md\0";
    const input = ports({
      git: (args) => ({ exitCode: 0, stdout: args[0] === "rev-parse" ? sha : status }),
    });
    expect(collectBuildInfo(input)).toMatchObject({ sourceDirty: false, sourceDirtyPaths: [] });
    status += " M docs/README.md\0 M file with spaces.ts\0R  renamed.ts\0old.ts\0";
    expect(collectBuildInfo(input)).toMatchObject({
      sourceDirty: true,
      sourceDirtyPaths: ["docs/README.md", "file with spaces.ts", "old.ts", "renamed.ts"],
    });
  });
  test("sorts and caps dirty path evidence at 50", () => {
    const paths = Array.from(
      { length: 52 },
      (_, index) => `file-${String(index).padStart(2, "0")}`,
    ).reverse();
    const result = collectBuildInfo(
      ports({
        git: (args) => ({
          exitCode: 0,
          stdout: args[0] === "rev-parse" ? sha : paths.map((path) => ` M ${path}\0`).join(""),
        }),
      }),
    );
    expect(result.sourceDirty).toBe(true);
    expect(result.sourceDirtyPaths).toEqual(paths.sort().slice(0, 50));
  });
  test("is reproducible without timestamps and reports absent native checksums", () => {
    const input = ports({
      registry: [],
      nightly: { version: "nightly", apkSha256: "", ipaSha256: "", runnerSha256: "" },
    });
    expect(collectBuildInfo(input)).toEqual(collectBuildInfo(input));
    expect(JSON.stringify(collectBuildInfo(input))).not.toContain("timestamp");
    expect(collectBuildInfo(input).nativeResources).toBeNull();
    expect(collectBuildInfo(input).nativeResourcesFrom).toBeNull();
  });
});
