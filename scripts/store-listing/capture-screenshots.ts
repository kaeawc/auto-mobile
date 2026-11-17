#!/usr/bin/env bun
/** Emit plans or capture store screenshots on explicitly pinned, dedicated devices. */
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { buildScreenshotPlan, toDrivePlan, type PlanPins } from "./screenshotPlan";

import { tmpdir } from "node:os";
import {
  captureShots,
  checkSeedTargets,
  compareTrees,
  selectShots,
  type CaptureRunner,
} from "./captureRunner";
import { privateEnvError } from "../mcp-drive";

export interface CaptureArgs {
  list: boolean;
  emit?: string;
  run?: boolean;
  out?: string;
  profile?: string;
  shot?: string;
  verifyIdentical?: [string, string];
  pins: Partial<PlanPins>;
}

export function parseArgs(argv: readonly string[]): CaptureArgs {
  const parsed: CaptureArgs = { list: false, pins: {} };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--list") {
      parsed.list = true;
      continue;
    }
    if (flag === "--run") {
      parsed.run = true;
      continue;
    }
    const value = argv[++i];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    switch (flag) {
      case "--emit":
        parsed.emit = value;
        break;
      case "--out":
        parsed.out = value;
        break;
      case "--profile":
        parsed.profile = value;
        break;
      case "--shot":
        parsed.shot = value;
        break;
      case "--android-serial":
        parsed.pins.androidSerial = value;
        break;
      case "--ios-udid":
        parsed.pins.iosUdid = value;
        break;
      case "--android-app-id":
        parsed.pins.androidAppId = value;
        break;
      case "--ios-app-id":
        parsed.pins.iosAppId = value;
        break;
      case "--verify-identical": {
        const second = argv[++i];
        if (!second || second.startsWith("--")) {
          throw new Error("--verify-identical needs two directories");
        }
        parsed.verifyIdentical = [value, second];
        break;
      }
      default:
        throw new Error(`Unknown flag ${flag}`);
    }
  }
  return parsed;
}

export function manifestFor(pins: PlanPins) {
  return buildScreenshotPlan(pins).map((shot) => ({
    id: shot.id,
    plan: `${shot.id}.plan.json`,
    destination: shot.destination,
    pixels: shot.profile.pixels,
    hostSteps: shot.steps.flatMap((step) => (step.kind === "host" ? [step] : [])),
  }));
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.verifyIdentical) {
    const differences = compareTrees(...args.verifyIdentical);
    differences.forEach((difference) => console.error(difference));
    if (differences.length === 0) {
      console.log("Output trees are byte-identical");
    }
    return differences.length ? 1 : 0;
  }
  if (args.run) {
    if (!args.out) {
      throw new Error("--run requires --out");
    }
    const shots = selectShots(args.pins, args.profile, args.shot);
    const problem = privateEnvError(process.env);
    if (problem) {
      throw new Error(problem);
    }
    const plans = mkdtempSync(join(tmpdir(), "store-listing-plans-"));
    const runner: CaptureRunner = {
      async run(argv) {
        const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        process.stderr.write(stderr);
        const code = await child.exited;
        if (code !== 0) {
          // stderr carries the reason a probe classifies (e.g. simctl's not-installed text).
          throw new Error(`${argv[0]} exited ${code}: ${stdout}\n${stderr}`);
        }
        return stdout;
      },
    };
    try {
      await checkSeedTargets(shots, args.pins, runner);
      await captureShots(shots, resolve(args.out), plans, runner, {
        read: (path) => readFileSync(path),
        write: (path, data) => {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, data);
        },
      });
    } finally {
      rmSync(plans, { recursive: true, force: true });
    }
    console.log(`Captured ${shots.length} screenshots under ${resolve(args.out)}`);
    return 0;
  }
  if (args.list) {
    buildScreenshotPlan({ androidSerial: "<serial>", iosUdid: "<udid>" }).forEach((shot) => {
      console.log(`${shot.id}\t${shot.destination}`);
    });
    return 0;
  }
  const { androidSerial, iosUdid } = args.pins;
  if (args.emit === undefined || androidSerial === undefined || iosUdid === undefined) {
    console.error("Usage: --list | --emit <dir> --android-serial <serial> --ios-udid <udid>");
    return 2;
  }
  const pins: PlanPins = { androidSerial, iosUdid, ...args.pins };
  const dir = resolve(args.emit);
  mkdirSync(dir, { recursive: true });
  buildScreenshotPlan(pins).forEach((shot) => {
    writeFileSync(
      join(dir, `${shot.id}.plan.json`),
      `${JSON.stringify(toDrivePlan(shot), null, 2)}\n`,
    );
  });
  const manifest = manifestFor(pins);
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${manifest.length} shot plans under ${dir}`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
