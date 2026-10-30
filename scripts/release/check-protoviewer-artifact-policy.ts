#!/usr/bin/env bun
/**
 * ProtoViewer release-artifact policy gate (issue #14154).
 *
 *   bun scripts/release/check-protoviewer-artifact-policy.ts android <apk> [--allow-snapshot]
 *       [--aapt2 <path>] [--policy <json>]
 *   bun scripts/release/check-protoviewer-artifact-policy.ts ios <ProtoViewer.app|.ipa|.zip>
 *       [--platform iphoneos|iphonesimulator] [--policy <json>]
 *
 * Judges the BUILT artifact, not the source manifests, against the checked-in allowlists in
 * scripts/release/protoviewer-artifact-policy.json. Exit 0 when it conforms (advisory rules print
 * warnings), 1 on a policy violation, 2 when the artifact or a tool could not be read.
 * Local use: scripts/release/protoviewer-artifact-policy.sh.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { runAndroidGate, runIosGate } from "./lib/artifact-policy/gate";
import type { IosPlatform } from "./lib/artifact-policy/iosArtifactPolicy";
import {
  formatReport,
  parseArtifactPolicy,
  type PolicyReport,
} from "./lib/artifact-policy/policyData";
import { ExecFileToolRunner, type ToolRunner } from "./lib/artifact-policy/toolRunner";

const DEFAULT_POLICY = path.join(import.meta.dir, "protoviewer-artifact-policy.json");
const PLATFORMS: Record<string, IosPlatform> = {
  iphoneos: "iPhoneOS",
  iphonesimulator: "iPhoneSimulator",
};

function versionKey(name: string): number[] {
  return name.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a: string, b: string): number {
  const left = versionKey(a);
  const right = versionKey(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

/** `--aapt2`, `$AAPT2`, the newest SDK build-tools aapt2, then `aapt2` on PATH. */
function resolveAapt2(explicit: string | undefined): string {
  if (explicit) {
    return explicit;
  }
  if (process.env.AAPT2) {
    return process.env.AAPT2;
  }
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const buildTools = sdk ? path.join(sdk, "build-tools") : undefined;
  if (buildTools && existsSync(buildTools)) {
    const newest = readdirSync(buildTools)
      .filter((version) => existsSync(path.join(buildTools, version, "aapt2")))
      .sort(compareVersions)
      .pop();
    if (newest) {
      return path.join(buildTools, newest, "aapt2");
    }
  }
  return "aapt2";
}

function listRelative(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" }).map((entry) =>
    entry.split(path.sep).join("/"),
  );
}

async function locateApp(
  artifact: string,
  scratch: string,
  runner: ToolRunner,
): Promise<{ app: string; extraPaths: string[] }> {
  if (statSync(artifact).isDirectory()) {
    return { app: artifact, extraPaths: [] };
  }
  const root = path.join(scratch, "extracted");
  await runner.run("unzip", ["-q", "-o", artifact, "-d", root]);
  const payload = path.join(root, "Payload");
  const searchRoot = existsSync(payload) ? payload : root;
  const apps = readdirSync(searchRoot).filter((entry) => entry.endsWith(".app"));
  if (apps.length !== 1) {
    throw new Error(`expected exactly one .app in ${artifact}, found ${apps.length}`);
  }
  const appRelative = path.relative(root, path.join(searchRoot, apps[0])).split(path.sep).join("/");
  // Archive-level extras (Symbols/, a stray .dSYM); the app's own files are listed separately.
  const extraPaths = listRelative(root).filter(
    (entry) =>
      entry !== "Payload" &&
      entry !== appRelative &&
      !entry.startsWith("Payload/") &&
      !entry.startsWith(`${appRelative}/`),
  );
  return { app: path.join(searchRoot, apps[0]), extraPaths };
}

async function main(argv: readonly string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      "allow-snapshot": { type: "boolean", default: false },
      aapt2: { type: "string" },
      platform: { type: "string", default: "iphoneos" },
      policy: { type: "string", default: DEFAULT_POLICY },
    },
  });
  const [target, artifact] = positionals;
  if ((target !== "android" && target !== "ios") || !artifact || positionals.length !== 2) {
    console.error("usage: check-protoviewer-artifact-policy.ts <android|ios> <artifact> [options]");
    return 2;
  }
  const policy = parseArtifactPolicy(readFileSync(values.policy, "utf8"));
  const runner = new ExecFileToolRunner();
  const scratch = mkdtempSync(path.join(tmpdir(), "protoviewer-policy-"));
  try {
    let report: PolicyReport;
    if (target === "android") {
      report = await runAndroidGate(
        {
          apkPath: artifact,
          aapt2: resolveAapt2(values.aapt2),
          allowSnapshotVersion: values["allow-snapshot"],
        },
        policy,
        runner,
      );
    } else {
      const platform = PLATFORMS[values.platform];
      if (!platform) {
        console.error(`--platform must be iphoneos or iphonesimulator, got ${values.platform}`);
        return 2;
      }
      const { app, extraPaths } = await locateApp(artifact, scratch, runner);
      report = await runIosGate(
        { appPath: app, platform, files: { list: () => [...listRelative(app), ...extraPaths] } },
        policy,
        runner,
      );
    }
    const output = formatReport(artifact, report);
    if (report.failures.length > 0) {
      console.error(output);
      return 1;
    }
    console.log(output);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(
        `ProtoViewer artifact policy could not run: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(2);
    },
  );
}
