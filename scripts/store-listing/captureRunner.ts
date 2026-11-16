import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readToolEnvelopePayload } from "../../src/utils/toolEnvelopePayload";
import { readImageHeaderDimensions } from "../../src/utils/screenshot/imageHeaderDimensions";
import {
  buildScreenshotPlan,
  toDrivePlan,
  type PlanPins,
  type ScreenshotShot,
} from "./screenshotPlan";

/** One argv-based process boundary for host commands and the persistent MCP driver. */
export interface CaptureRunner {
  run(argv: string[]): Promise<string>;
}
export interface CaptureFiles {
  read(path: string): Buffer;
  write(path: string, data: string | Buffer): void;
}

export function selectShots(
  pins: Partial<PlanPins>,
  profile?: string,
  id?: string,
): ScreenshotShot[] {
  const shots = buildScreenshotPlan({
    androidSerial: pins.androidSerial ?? "",
    iosUdid: pins.iosUdid ?? "",
    androidAppId: pins.androidAppId,
    iosAppId: pins.iosAppId,
  })
    .filter((shot) => (!profile || shot.profile.id === profile) && (!id || shot.id === id))
    .filter((shot) => profile || id || pins.iosUdid || shot.profile.platform === "android");
  if (shots.length === 0) {
    throw new Error("No shots match --profile / --shot");
  }
  for (const shot of shots) {
    const pin = shot.profile.platform === "android" ? pins.androidSerial : pins.iosUdid;
    if (!pin?.trim()) {
      throw new Error(
        `Missing --${shot.profile.platform === "android" ? "android-serial" : "ios-udid"}`,
      );
    }
  }
  return shots;
}

/** --json prints the envelope after each ### tool header, followed by the next header or session. */
export function screenshotFromOutput(stdout: string): string {
  const lines = stdout.split("\n");
  const start = lines.findLastIndex((line) => line.startsWith("### observe:"));
  if (start < 0) {
    throw new Error("Driver returned no observe screenshotPath");
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("### ") || line.startsWith("session: "));
  const envelope: unknown = JSON.parse((end < 0 ? rest : rest.slice(0, end)).join("\n"));
  const path = readToolEnvelopePayload(envelope)?.payload.screenshotPath;
  if (typeof path !== "string" || !path.trim()) {
    throw new Error("observe returned no screenshotPath");
  }
  return path;
}

export async function captureShots(
  shots: readonly ScreenshotShot[],
  out: string,
  plans: string,
  runner: CaptureRunner,
  files: CaptureFiles,
): Promise<void> {
  for (const shot of shots) {
    for (const step of shot.steps) {
      if (step.kind === "host") {
        await runner.run(step.argv);
      }
    }
    const plan = join(plans, `${shot.id}.plan.json`);
    files.write(plan, `${JSON.stringify(toDrivePlan(shot), null, 2)}\n`);
    const stdout = await runner.run([
      "bun",
      "scripts/mcp-drive.ts",
      "--private",
      "--json",
      "--plan",
      plan,
    ]);
    const bytes = files.read(screenshotFromOutput(stdout));
    const size = readImageHeaderDimensions(bytes);
    const png = bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
    if (
      !png ||
      size?.width !== shot.profile.pixels.width ||
      size.height !== shot.profile.pixels.height
    ) {
      throw new Error(
        `${shot.id}: expected PNG ${shot.profile.pixels.width}x${shot.profile.pixels.height}, got ${size ? `${size.width}x${size.height}` : "invalid image"}`,
      );
    }
    files.write(join(out, shot.destination), bytes);
  }
}

function treeHashes(root: string, relative = ""): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) {
      for (const [key, hash] of treeHashes(root, path)) {
        hashes.set(key, hash);
      }
    } else if (entry.isFile()) {
      hashes.set(
        path,
        createHash("sha256")
          .update(readFileSync(join(root, path)))
          .digest("hex"),
      );
    } else {
      throw new Error(`Output tree contains a non-regular file: ${path}`);
    }
  }
  return hashes;
}

export function compareTrees(first: string, second: string): string[] {
  const a = treeHashes(first);
  const b = treeHashes(second);
  return [...new Set([...a.keys(), ...b.keys()])].sort().flatMap((path) => {
    if (!a.has(path)) {
      return [`${path}: missing from first tree`];
    }
    if (!b.has(path)) {
      return [`${path}: missing from second tree`];
    }
    return a.get(path) === b.get(path) ? [] : [`${path}: different sha256`];
  });
}
