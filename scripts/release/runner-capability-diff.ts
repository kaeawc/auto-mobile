#!/usr/bin/env bun
/**
 * Helper for scripts/release/runner-capability-note.sh (#17618).
 *
 *   bun scripts/release/runner-capability-diff.ts --vcs git|jj --base-rev <rev> [host.ts ...]
 *
 * Run from the checkout root. Prints, one per line, each capability the working tree's
 * control-proxy sources newly advertise (versus <rev>) that the listed changed host files newly
 * gate on. Paths are repository-relative; a file missing on either side reads as empty.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { ADVERTISING_SOURCES } from "./lib/artifact-capabilities";
import {
  type HostFileSides,
  RUNNER_ARTIFACTS,
  type RunnerSources,
  unreleasedRunnerCapabilitiesInUse,
} from "./lib/runner-capability-note";

interface Args {
  vcs: "git" | "jj";
  baseRev: string;
  hostFiles: string[];
}

function parseArgs(argv: string[]): Args {
  let vcs: Args["vcs"] = "git";
  let baseRev = "";
  const hostFiles: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--vcs") {
      const value = argv[++index];
      if (value !== "git" && value !== "jj") {
        throw new Error(`--vcs must be git or jj, got ${value}`);
      }
      vcs = value;
    } else if (arg === "--base-rev") {
      baseRev = argv[++index] ?? "";
    } else {
      hostFiles.push(arg);
    }
  }
  if (baseRev === "") {
    throw new Error("--base-rev is required");
  }
  return { vcs, baseRev, hostFiles };
}

function readCurrent(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function readBase(args: Args, file: string): string {
  const command =
    args.vcs === "jj"
      ? ["jj", ["file", "show", "-r", args.baseRev, file]]
      : ["git", ["show", `${args.baseRev}:${file}`]];
  try {
    return execFileSync(command[0] as string, command[1] as string[], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    // A file added since the merge-base has no base version; it reads as empty.
    return "";
  }
}

const args = parseArgs(process.argv.slice(2));
const runnerSources = Object.fromEntries(
  RUNNER_ARTIFACTS.map((artifact) => [
    artifact,
    {
      base: ADVERTISING_SOURCES[artifact].map((file) => readBase(args, file)).join("\n"),
      current: ADVERTISING_SOURCES[artifact].map(readCurrent).join("\n"),
    },
  ]),
) as RunnerSources;
const hostFiles: HostFileSides[] = args.hostFiles.map((file) => ({
  base: readBase(args, file),
  current: readCurrent(file),
}));
for (const name of unreleasedRunnerCapabilitiesInUse(runnerSources, hostFiles)) {
  process.stdout.write(`${name}\n`);
}
