#!/usr/bin/env bun
import { defaultTimer } from "../../src/utils/SystemTimer";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AttestationLane } from "./attestation/attestationSchema";
import { resolveAutoMobileBaseDir } from "../../src/utils/tempDir";
import { parseGateSpec } from "./attestation/cliArgs";
import { Exec, GitTreeProbe, resolveRepositoryRoot, selectVcs } from "./attestation/gitTreeProbe";
import {
  CompositeSink,
  LANE_INPUT_PATHS,
  LocalFileSink,
  ProduceOptions,
  TreeEntriesInputHasher,
  UnsignedSigner,
  produceAttestations,
} from "./attestation/produceAttestations";

export interface CliDeps {
  log(message: string): void;
  warn(message: string): void;
  createOptions(outDir: string | undefined): Promise<Omit<ProduceOptions, "lanes">>;
}
export async function runCli(
  argv: string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: CliDeps,
): Promise<number> {
  if (env.AUTOMOBILE_ATTESTATIONS === "0") {
    deps.log("attestations disabled");
    return 0;
  }
  let parsed;
  let lane: AttestationLane;
  let gates;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        lane: { type: "string" },
        gate: { type: "string", multiple: true },
        "out-dir": { type: "string" },
        scope: { type: "string", default: "partial" },
        "scope-note": { type: "string", default: "" },
        "expected-head": { type: "string" },
        "started-dirty": { type: "boolean" },
        "print-dirty-at-start": { type: "boolean" },
      },
      allowPositionals: false,
    }).values;
    if (!parsed.lane || !["node", "android", "ios"].includes(parsed.lane)) {
      throw new Error("--lane node|android|ios required");
    }
    if (parsed.scope !== "full" && parsed.scope !== "partial") {
      throw new Error("--scope full|partial required");
    }
    lane = parsed.lane as AttestationLane;
    gates = (parsed.gate ?? []).map(parseGateSpec);
    if (!parsed["print-dirty-at-start"] && gates.length === 0) {
      throw new Error("at least one --gate required");
    }
  } catch (error) {
    deps.warn(String(error));
    return 2;
  }
  try {
    const options = await deps.createOptions(parsed["out-dir"]);
    if (parsed["print-dirty-at-start"]) {
      deps.log((await options.probe.dirtyPaths(LANE_INPUT_PATHS[lane])).length ? "dirty" : "clean");
      return 0;
    }
    const results = await produceAttestations({
      ...options,
      lanes: [
        {
          lane,
          gates,
          scope: parsed.scope,
          scopeNote: parsed["scope-note"],
          expectedHead: parsed["expected-head"],
          startedDirty: parsed["started-dirty"],
        },
      ],
    });
    for (const result of results) {
      deps.log(
        `${result.lane}: ${result.outcome}${result.id ? ` ${result.id}` : ""}${result.detail ? ` (${result.detail})` : ""}`,
      );
    }
    return 0;
  } catch (error) {
    deps.warn(`attestation skipped: ${String(error)}`);
    return 0;
  }
}
const exec: Exec = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      resolve({ code: error ? 1 : 0, stdout });
    });
  });
if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), process.env, {
    log: (message) => console.log(message),
    warn: (message) => console.warn(message),
    async createOptions(outDir) {
      const root = await resolveRepositoryRoot(exec);
      return {
        probe: new GitTreeProbe(selectVcs(existsSync, root), exec, root),
        hasher: new TreeEntriesInputHasher(),
        signer: new UnsignedSigner(),
        sink: new CompositeSink(
          [new LocalFileSink(outDir ?? join(resolveAutoMobileBaseDir(), "attestations"))],
          (message) => console.warn(message),
        ),
        clock: { nowMs: () => defaultTimer.now() },
        environment: {
          os: platform(),
          arch: arch(),
          bunVersion: process.versions.bun ?? null,
          toolVersions: {},
        },
        warn: (message) => console.warn(message),
      };
    },
  });
}
