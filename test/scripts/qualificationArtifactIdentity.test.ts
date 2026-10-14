import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { readTarGzEntries } from "../../scripts/qualification/tarEntries";
import {
  identifyArtifact,
  parseIdentityArgs,
  UsageError,
  type ArtifactIdentityPorts,
  type ArtifactIdentityRecord,
} from "../../scripts/qualification/artifactIdentity";
import { REQUIRED_PACKED_RUNTIME_ASSETS } from "../../scripts/build/packed-runtime-assets";
import { DAEMON_PACKAGE_NAME, type ReleaseChecksumEntry } from "../../src/constants/release";

const root = resolve("/fixture/package");
const oldSha = "b51bfe50dfeb608ed838acf89481b70652084b81";
const currentSha = "d78115c7b861d8a051152fc6f79bd1eebdd13154";
const apk = new TextEncoder().encode("apk");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const release: ReleaseChecksumEntry = {
  version: "0.0.84",
  apkSha256: hash(apk),
  ipaSha256: "2".repeat(64),
  runnerSha256: "3".repeat(64),
  runnerSha256Target: "xctest",
};
function packageTarball(files: Map<string, Uint8Array>): Uint8Array {
  const entries = [...files].map(([path, data]) => {
    const header = Buffer.alloc(512);
    header.write(`package/${path.slice(root.length + 1).replaceAll("\\", "/")}`, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  });
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}
test("packageTarball uses forward slashes for Windows fixture keys", () => {
  const entries = readTarGzEntries(
    packageTarball(new Map([[`${root}\\dist\\src\\index.js`, new Uint8Array([1])]])),
  );
  expect(entries.map(({ path }) => path)).toEqual(["package/dist/src/index.js"]);
  expect(entries.every(({ path }) => !path.includes("\\"))).toBe(true);
});
function fixture() {
  const files = new Map<string, Uint8Array>();
  const put = (path: string, text: string | Uint8Array) =>
    files.set(path, typeof text === "string" ? new TextEncoder().encode(text) : text);
  put(
    join(root, "package.json"),
    JSON.stringify({ name: DAEMON_PACKAGE_NAME, version: release.version }),
  );
  for (const path of REQUIRED_PACKED_RUNTIME_ASSETS) {
    put(join(root, path.endsWith("/") ? `${path}migration.ts` : path), "asset");
  }
  put(
    join(root, "dist/src/index.js"),
    [release.apkSha256, release.ipaSha256, release.runnerSha256].join("\n"),
  );
  put(
    join(root, "schemas/managed-slot-contract.json"),
    JSON.stringify({
      contractVersions: [1],
      daemonCapabilities: {
        base: "managed-slots/v1",
        additive: [{ capability: "managed-slots/v1.deviceFamily" }],
      },
    }),
  );
  const gitCalls: Array<{ args: readonly string[]; cwd: string }> = [];
  const ports: ArtifactIdentityPorts = {
    exists: (path) => files.has(path),
    readBytes: (path) => {
      const bytes = files.get(path);
      if (!bytes) {
        throw new Error(`Missing fixture: ${path}`);
      }
      return bytes;
    },
    readText: (path) => new TextDecoder().decode(ports.readBytes(path)),
    listFiles: (dir) =>
      [...files.keys()]
        .map((path) => path.replaceAll("\\", "/"))
        .filter((path) => path.startsWith(`${dir.replaceAll("\\", "/")}/`))
        .map((path) => path.slice(dir.replaceAll("\\", "/").length + 1))
        .sort(),
    listNonRegular: () => [],
    git: (args, cwd) => {
      gitCalls.push({ args, cwd });
      return { exitCode: 0, stdout: `${oldSha}\n` };
    },
    registry: [release],
  };
  const buildInfo = (sha = oldSha, dirty = false) =>
    put(
      join(root, "dist/build-info.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: DAEMON_PACKAGE_NAME,
        version: release.version,
        sourceSha: sha,
        sourceShaFrom: "git",
        sourceDirty: dirty,
        nativeResources: {
          apkSha256: release.apkSha256,
          ipaSha256: release.ipaSha256,
          runnerSha256: release.runnerSha256,
        },
        nativeResourcesFrom: "release-registry",
      }),
    );
  return { files, put, ports, buildInfo, gitCalls };
}
function check(record: ArtifactIdentityRecord, id: string) {
  return record.checks.find((entry) => entry.id === id)!;
}
function identify(ports: ArtifactIdentityPorts) {
  return identifyArtifact({ packageDir: root, repoDir: "/repo" }, ports);
}

describe("artifact identity", () => {
  test("refuses an unbuilt source checkout and gives extraction instructions", () => {
    const f = fixture();
    f.put(join(root, ".git"), "gitdir: /repo");
    f.files.delete(join(root, "dist/src/index.js"));
    let listCalls = 0;
    f.ports.listFiles = () => {
      listCalls++;
      return [];
    };
    const record = identify(f.ports);
    expect(listCalls).toBe(0);
    expect(record.checks.map(({ id }) => id)).toEqual(["package_root", "not_source_checkout"]);
    expect(record.package.contentSha256).toBeNull();
    expect(record.package.fileCount).toBe(0);
    expect(record.verdict).toBe("refused");
    expect(check(record, "not_source_checkout")).toMatchObject({ status: "fail" });
    expect(check(record, "not_source_checkout").detail).toContain("unbuilt source checkout");
    expect(check(record, "not_source_checkout").detail).toContain("bun run build && npm pack");
    expect(check(record, "not_source_checkout").detail).toContain("--tarball");
  });
  test("refuses a built source checkout detected through src/index.ts", () => {
    const f = fixture();
    f.put(join(root, "src/index.ts"), "source");
    expect(check(identify(f.ports), "not_source_checkout").detail).toContain("source checkout");
    expect(check(identify(f.ports), "not_source_checkout").status).toBe("fail");
  });
  test("refuses the stale release SHA and warns about its absent contract", () => {
    const f = fixture();
    f.files.delete(join(root, "schemas/managed-slot-contract.json"));
    const record = identifyArtifact(
      { packageDir: root, repoDir: "/repo", expectSourceSha: currentSha },
      f.ports,
    );
    expect(record.verdict).toBe("refused");
    expect(record.source.evidence).toBe("release-tag");
    expect(check(record, "source_sha").status).toBe("fail");
    expect(check(record, "source_sha").detail).toContain(oldSha);
    expect(check(record, "source_sha").detail).toContain(`but qualification expects ${currentSha}`);
    expect(check(record, "managed_slot_contract").status).toBe("warn");
    expect(check(record, "build_info").status).toBe("warn");
    expect(f.gitCalls[0]).toEqual({
      args: ["rev-parse", "--verify", "--quiet", "refs/tags/0.0.84^{commit}"],
      cwd: "/repo",
    });
  });
  test("accepts a matching case-insensitive SHA prefix at local-build proof level", () => {
    const f = fixture();
    const record = identifyArtifact(
      { packageDir: root, repoDir: "/repo", expectSourceSha: "B51BFE5" },
      f.ports,
    );
    expect(record.verdict).toBe("identified");
    expect(record.proofLevel).toBe("local-build");
    expect(check(record, "source_sha").detail).toContain("matching expected B51BFE5");
    expect(check(record, "source_sha").detail).not.toContain("but qualification expects");
    expect(record.managedSlotContract).toEqual({
      present: true,
      contractVersions: [1],
      capabilities: ["managed-slots/v1", "managed-slots/v1.deviceFamily"],
    });
  });
  test("warns on local build-info and tag disagreement", () => {
    const f = fixture();
    f.buildInfo(currentSha);
    const record = identify(f.ports);
    expect(record.verdict).toBe("identified");
    expect(record.source.evidence).toBe("build-info");
    expect(check(record, "source_sha").status).toBe("warn");
    expect(check(record, "source_sha").detail).toContain(
      `version 0.0.84 is also release tag 0.0.84 at ${oldSha}; this build (${currentSha}) is not that release`,
    );
    expect(
      check(
        identifyArtifact({ packageDir: root, repoDir: "/repo", expectSourceSha: oldSha }, f.ports),
        "source_sha",
      ).status,
    ).toBe("fail");
  });
  test("refuses release-tag disagreement after awarding exact published proof", () => {
    const f = fixture();
    f.buildInfo(currentSha);
    const bytes = packageTarball(f.files);
    f.put("/artifact.tgz", bytes);
    const record = identifyArtifact(
      {
        packageDir: root,
        repoDir: "/repo",
        tarball: "/artifact.tgz",
        expectedIntegrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      },
      f.ports,
    );
    expect(record.proofLevel).toBe("published-package");
    expect(check(record, "tarball_contents").status).toBe("pass");
    expect(check(record, "source_sha").status).toBe("fail");
    expect(record.verdict).toBe("refused");
  });
  test("dirty build warning lists at most ten dirty paths", () => {
    const f = fixture();
    f.buildInfo(oldSha, true);
    const path = join(root, "dist/build-info.json");
    const info = JSON.parse(f.ports.readText(path));
    info.sourceDirtyPaths = Array.from({ length: 12 }, (_, index) => `dirty-${index}`);
    f.put(path, JSON.stringify(info));
    const detail = check(identify(f.ports), "build_info").detail;
    expect(detail).toContain(info.sourceDirtyPaths.slice(0, 10).join(", "));
    expect(detail).not.toContain("dirty-10");
  });
  test("uses build-info without a repo and warns on dirty builds", () => {
    const f = fixture();
    f.buildInfo(currentSha, true);
    const record = identifyArtifact({ packageDir: root, expectSourceSha: currentSha }, f.ports);
    expect(record.verdict).toBe("identified");
    expect(record.source.dirty).toBe(true);
    expect(record.nativeResources.from).toBe("build-info");
    expect(check(record, "build_info").status).toBe("warn");
    expect(f.gitCalls).toHaveLength(0);
  });
  test("refuses mismatched build-info package version", () => {
    const f = fixture();
    f.buildInfo();
    const path = join(root, "dist/build-info.json");
    const info = JSON.parse(f.ports.readText(path));
    info.version = "0.0.83";
    f.put(path, JSON.stringify(info));
    expect(check(identify(f.ports), "build_info").status).toBe("fail");
  });
  test("falls back to v-prefixed tags and refuses an unknown expected source", () => {
    const f = fixture();
    f.ports.git = (args) => ({ exitCode: args[3].includes("tags/v") ? 0 : 1, stdout: oldSha });
    expect(identify(f.ports).source.tag).toBe("v0.0.84");
    f.ports.git = () => ({ exitCode: 1, stdout: "" });
    expect(
      check(identifyArtifact({ packageDir: root, expectSourceSha: oldSha }, f.ports), "source_sha")
        .status,
    ).toBe("fail");
    expect(check(identify(f.ports), "source_sha").status).toBe("warn");
  });
  test("fails when a registry SHA is absent from bundle text", () => {
    const f = fixture();
    f.put(join(root, "dist/src/index.js"), release.apkSha256);
    const record = identify(f.ports);
    expect(record.verdict).toBe("refused");
    expect(check(record, "native_resources").status).toBe("fail");
    expect(record.nativeResources.entries.ipaSha256.pinnedInBundle).toBe(false);
  });
  test("computes SRI and sha1, promotes only verified tarballs, and refuses mismatch", () => {
    const f = fixture();
    const bytes = packageTarball(f.files);
    f.put("/artifact.tgz", bytes);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const options = { packageDir: root, tarball: "/artifact.tgz", expectedIntegrity: integrity };
    const verified = identifyArtifact(options, f.ports);
    expect(verified.verdict).toBe("identified");
    expect(verified.proofLevel).toBe("published-package");
    expect(check(verified, "tarball_contents").status).toBe("pass");
    expect(verified.tarball?.integrity).toBe(integrity);
    expect(verified.tarball?.shasum).toBe(createHash("sha1").update(bytes).digest("hex"));
    const mismatch = identifyArtifact({ ...options, expectedIntegrity: "sha512-wrong" }, f.ports);
    expect(mismatch.verdict).toBe("refused");
    expect(mismatch.proofLevel).toBe("local-build");
    const unverified = identifyArtifact({ ...options, expectedIntegrity: undefined }, f.ports);
    expect(check(unverified, "tarball_integrity").status).toBe("warn");
    expect(unverified.proofLevel).toBe("local-build");
  });
  test("refuses directory contents that differ from the integrity-verified tarball", () => {
    const f = fixture();
    const bytes = packageTarball(f.files);
    f.put("/artifact.tgz", bytes);
    f.put(join(root, "dist/src/index.js"), "changed bundle");
    const record = identifyArtifact(
      {
        packageDir: root,
        tarball: "/artifact.tgz",
        expectedIntegrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      },
      f.ports,
    );
    expect(check(record, "tarball_integrity").status).toBe("pass");
    expect(check(record, "tarball_contents").status).toBe("fail");
    expect(check(record, "tarball_contents").detail).toContain("dist/src/index.js");
    expect(record.verdict).toBe("refused");
    expect(record.proofLevel).toBe("local-build");
  });
  test("allows extra files only beneath node_modules path segments", () => {
    const f = fixture();
    const bytes = packageTarball(f.files);
    f.put("/artifact.tgz", bytes);
    const options = {
      packageDir: root,
      tarball: "/artifact.tgz",
      expectedIntegrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    };
    f.put(join(root, "node_modules/x/index.js"), "dependency");
    f.put(join(root, "dist/node_modules/y/index.js"), "nested dependency");
    const allowed = identifyArtifact(options, f.ports);
    expect(allowed.verdict).toBe("identified");
    expect(allowed.proofLevel).toBe("local-build");
    expect(check(allowed, "published_exactness").status).toBe("warn");
    expect(check(allowed, "published_exactness").detail).toContain("node_modules/x/index.js");
    expect(check(allowed, "tarball_contents").detail).toContain(
      "2 extra node_modules files allowed",
    );
    f.put(join(root, "dist/extra.js"), "extra");
    const refused = identifyArtifact(options, f.ports);
    expect(refused.verdict).toBe("refused");
    expect(refused.proofLevel).toBe("local-build");
    expect(check(refused, "tarball_contents")).toMatchObject({ status: "fail" });
    expect(check(refused, "tarball_contents").detail).toContain("dist/extra.js");
  });
  test("refuses non-regular dist entries and counts allowed bin links without published proof", () => {
    const f = fixture();
    const bytes = packageTarball(f.files);
    f.put("/artifact.tgz", bytes);
    const options = {
      packageDir: root,
      tarball: "/artifact.tgz",
      expectedIntegrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    };
    f.ports.listNonRegular = () => ["dist/evil.js", "dist/evildir", "dist/pipe"];
    const refused = identifyArtifact(options, f.ports);
    expect(check(refused, "package_file_types").status).toBe("fail");
    expect(check(refused, "package_file_types").detail).toContain("dist/evildir");
    expect(refused.verdict).toBe("refused");
    expect(refused.proofLevel).toBe("local-build");
    f.ports.listNonRegular = () => ["node_modules/.bin/x", "dist/node_modules/.bin/y"];
    const allowed = identifyArtifact(options, f.ports);
    expect(check(allowed, "package_file_types")).toMatchObject({ status: "pass" });
    expect(check(allowed, "package_file_types").detail).toContain("2");
    expect(allowed.verdict).toBe("identified");
    expect(allowed.proofLevel).toBe("local-build");
    expect(check(allowed, "published_exactness").status).toBe("warn");
    f.ports.listNonRegular = () => ["node_modules/.bin-evil/x"];
    expect(check(identifyArtifact(options, f.ports), "package_file_types").status).toBe("fail");
  });
  test("reports missing files and caps differing paths at ten with a total", () => {
    const f = fixture();
    const bytes = packageTarball(f.files);
    f.put("/artifact.tgz", bytes);
    f.files.delete(join(root, "dist/src/index.js"));
    for (let i = 0; i < 12; i++) {
      f.put(join(root, `extra-${i}.txt`), "extra");
    }
    const record = identifyArtifact({ packageDir: root, tarball: "/artifact.tgz" }, f.ports);
    const detail = check(record, "tarball_contents").detail;
    expect(detail).toContain("13 differing/missing/extra paths");
    expect(detail).toContain("dist/src/index.js");
    expect(detail.split(": ")[1].split("; ")[0].split(", ")).toHaveLength(10);
    expect(record.verdict).toBe("refused");
  });
  test("turns a corrupt tarball into a failed contents check", () => {
    const f = fixture();
    f.put("/artifact.tgz", "invalid gzip");
    const record = identifyArtifact({ packageDir: root, tarball: "/artifact.tgz" }, f.ports);
    expect(check(record, "tarball_contents").status).toBe("fail");
    expect(check(record, "tarball_contents").detail).toContain("Unable to read gzip tar archive");
    expect(record.verdict).toBe("refused");
  });
  test("reports matching APK and mismatching IPA, without independently hashing runner", () => {
    const f = fixture();
    f.put(join("/assets", "control-proxy-debug.apk"), apk);
    f.put(join("/assets", "control-proxy.ipa"), "wrong");
    const record = identifyArtifact({ packageDir: root, nativeAssetsDir: "/assets" }, f.ports);
    expect(record.verdict).toBe("refused");
    expect(record.nativeResources.localAssets[0].match).toBe(true);
    expect(check(record, "native_assets").status).toBe("fail");
    expect(check(record, "native_assets").detail).toContain("control-proxy.ipa");
    expect(check(record, "native_assets").detail).toContain("runner SHA lives inside the IPA");
  });
  test("warns when native directory is empty or registry entry is absent", () => {
    const f = fixture();
    f.ports.registry = [];
    const record = identifyArtifact({ packageDir: root, nativeAssetsDir: "/assets" }, f.ports);
    expect(check(record, "native_assets").status).toBe("warn");
    expect(check(record, "native_resources").status).toBe("warn");
  });
  test("fails missing packed assets and wrong package root", () => {
    const f = fixture();
    f.files.delete(join(root, REQUIRED_PACKED_RUNTIME_ASSETS[1]));
    expect(check(identify(f.ports), "packed_assets").status).toBe("fail");
    f.put(join(root, "package.json"), JSON.stringify({ name: "other", version: "0.0.84" }));
    expect(check(identify(f.ports), "package_root").status).toBe("fail");
  });
  test("content hash sorts independently of ports and changes with one byte", () => {
    const f = fixture();
    const original = identify(f.ports);
    const list = f.ports.listFiles;
    f.ports.listFiles = (dir) => list(dir).reverse();
    expect(identify(f.ports).package.contentSha256).toBe(original.package.contentSha256);
    const paths = list(root);
    const manifest = paths
      .map((path) => `${hash(f.ports.readBytes(join(root, path)))}  ${path}\n`)
      .join("");
    expect(original.package.contentSha256).toBe(
      createHash("sha256").update(manifest).digest("hex"),
    );
    expect(original.package.fileCount).toBe(paths.length);
    f.put(join(root, "dist/src/index.js"), `${f.ports.readText(join(root, "dist/src/index.js"))}x`);
    expect(identify(f.ports).package.contentSha256).not.toBe(original.package.contentSha256);
  });
});
describe("parseIdentityArgs", () => {
  test("requires package-dir and rejects malformed arguments", () => {
    expect(() => parseIdentityArgs([])).toThrow(UsageError);
    expect(() => parseIdentityArgs(["--unknown"])).toThrow(UsageError);
    expect(() => parseIdentityArgs(["--package-dir", root, "--expect-source-sha", "xyz"])).toThrow(
      UsageError,
    );
    expect(() => parseIdentityArgs(["--package-dir", root, "--expected-integrity", "sri"])).toThrow(
      UsageError,
    );
  });
  test("parses all flags", () => {
    expect(
      parseIdentityArgs([
        "--package-dir",
        root,
        "--tarball",
        "/a.tgz",
        "--expected-integrity",
        "sha512-digest",
        "--repo",
        "/repo",
        "--expect-source-sha",
        oldSha,
        "--native-assets-dir",
        "/assets",
        "--out",
        "/out.json",
      ]),
    ).toEqual({
      packageDir: root,
      tarball: "/a.tgz",
      expectedIntegrity: "sha512-digest",
      repoDir: "/repo",
      expectSourceSha: oldSha,
      nativeAssetsDir: "/assets",
      out: "/out.json",
    });
  });
});
