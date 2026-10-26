#!/usr/bin/env bun
/**
 * Emits the ProtoViewer store-screenshot capture plan (#14152). It does not touch a device.
 *
 *   bun scripts/store-listing/capture-screenshots.ts --list
 *   bun scripts/store-listing/capture-screenshots.ts --emit <dir> --android-serial <serial> --ios-udid <udid>
 *
 * `--emit` writes one `<shot-id>.plan.json` per shot (the `{tool, args}` array that
 * `bun scripts/mcp-drive.ts --private --plan <file>` runs) and a `manifest.json` that lists each
 * shot's host steps, expected pixel size and destination under `fastlane/metadata`. The pins must be
 * the dedicated capture emulator and simulator, never a shared development device.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildScreenshotPlan, toDrivePlan, type PlanPins } from "./screenshotPlan";

export interface CaptureArgs {
  list: boolean;
  emit?: string;
  pins: Partial<PlanPins>;
}

export function parseArgs(argv: readonly string[]): CaptureArgs {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    list: argv.includes("--list"),
    emit: value("--emit"),
    pins: { androidSerial: value("--android-serial"), iosUdid: value("--ios-udid") },
  };
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

export function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
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
  const pins: PlanPins = { androidSerial, iosUdid };
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
  process.exitCode = main(process.argv.slice(2));
}
