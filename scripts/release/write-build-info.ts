#!/usr/bin/env bun
/** Usage: bun scripts/release/write-build-info.ts (invoked by prepack). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_CHECKSUM_REGISTRY,
  NIGHTLY_CHECKSUM_ENTRY,
  type ReleaseChecksumEntry,
} from "../../src/constants/release";

export interface BuildInfoNativeResources {
  [field: string]: string;
}
export interface BuildInfo {
  schemaVersion: 1;
  name: string;
  version: string;
  sourceSha: string | null;
  sourceShaFrom: "git" | "env" | null;
  sourceDirty: boolean | null;
  sourceDirtyPaths: string[] | null;
  nativeResources: BuildInfoNativeResources | null;
  nativeResourcesFrom: "release-registry" | "nightly" | null;
}
export interface BuildInfoPorts {
  readPackageJson(): { name: string; version: string };
  git(args: readonly string[]): { exitCode: number; stdout: string };
  env: Record<string, string | undefined>;
  registry: readonly ReleaseChecksumEntry[];
  nightly: ReleaseChecksumEntry;
}

export function collectBuildInfo(ports: BuildInfoPorts): BuildInfo {
  const pkg = ports.readPackageJson();
  const head = ports.git(["rev-parse", "HEAD"]);
  const gitSha = head.stdout.trim();
  const envSha = ports.env.GITHUB_SHA?.trim();
  const fromGit = head.exitCode === 0 && /^[a-f\d]{40}$/i.test(gitSha);
  const sourceSha = fromGit ? gitSha : envSha && /^[a-f\d]{40}$/i.test(envSha) ? envSha : null;
  const status = ports.git(["status", "--porcelain", "-z", "--untracked-files=no"]);
  const dirtyPaths: string[] = [];
  const statusEntries = status.stdout.split("\0");
  for (let index = 0; index < statusEntries.length; index++) {
    const entry = statusEntries[index];
    if (!entry) {
      continue;
    }
    dirtyPaths.push(entry.slice(3));
    // Porcelain -z puts a rename/copy's original path in the next NUL-delimited entry.
    if (entry.slice(0, 2).includes("R") || entry.slice(0, 2).includes("C")) {
      dirtyPaths.push(statusEntries[++index]);
    }
  }
  // npm prepublishOnly rewrites the tracked root README before prepack; that is not source dirt.
  const sourceDirtyPaths =
    status.exitCode === 0
      ? [...new Set(dirtyPaths.filter((path) => path && path !== "README.md"))].sort().slice(0, 50)
      : null;
  const release = ports.registry.find((entry) => entry.version === pkg.version);
  const entry = release ?? ports.nightly;
  const resources = Object.fromEntries(
    Object.entries(entry).filter(
      ([field, value]) => field.endsWith("Sha256") && typeof value === "string" && value.length > 0,
    ),
  );
  return {
    schemaVersion: 1,
    name: pkg.name,
    version: pkg.version,
    sourceSha: sourceSha?.toLowerCase() ?? null,
    sourceShaFrom: fromGit ? "git" : sourceSha ? "env" : null,
    sourceDirty: sourceDirtyPaths === null ? null : sourceDirtyPaths.length > 0,
    sourceDirtyPaths,
    nativeResources: Object.keys(resources).length ? resources : null,
    nativeResourcesFrom: Object.keys(resources).length
      ? release
        ? "release-registry"
        : "nightly"
      : null,
  };
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  if (!existsSync(resolve(root, "dist"))) {
    console.warn(
      "Build info skipped: dist/ does not exist; build before packing for artifact identity.",
    );
  } else {
    const info = collectBuildInfo({
      readPackageJson: () => JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")),
      git: (args) => {
        try {
          const result = Bun.spawnSync(["git", ...args], { cwd: root });
          return { exitCode: result.exitCode, stdout: result.stdout.toString() };
        } catch (error) {
          console.warn("Build info git probe unavailable:", error);
          return { exitCode: 1, stdout: "" };
        }
      },
      env: process.env,
      registry: RELEASE_CHECKSUM_REGISTRY,
      nightly: NIGHTLY_CHECKSUM_ENTRY,
    });
    const output = resolve(root, "dist/build-info.json");
    writeFileSync(output, `${JSON.stringify(info, null, 2)}\n`);
    console.log(output);
  }
}
