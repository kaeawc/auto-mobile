import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readToolEnvelopePayload } from "../../src/utils/toolEnvelopePayload";
import { readImageHeaderDimensions } from "../../src/utils/screenshot/imageHeaderDimensions";
import { errorMessage } from "../../src/models/describeUnknownError";
import { isMissingIosAppError } from "../../src/features/preferences/preferenceValues";
import { packageListingContains } from "../../src/utils/android-cmdline-tools/shellOutputHeuristics";
import {
  PROTOVIEWER_PACKAGE,
  PROTOVIEWER_PACKAGES,
  preferredProtoViewerPackage,
} from "../../src/features/prototype/protoViewer/protoViewerContract";
import {
  APP_IDS,
  buildScreenshotPlan,
  toDrivePlan,
  type PlanPins,
  type Platform,
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

/** The app ID a shot's `launchApp` steps (and so its capture) target. */
function captureAppId(shot: ScreenshotShot): string {
  const launch = shot.steps.find((step) => step.kind === "mcp" && step.tool === "launchApp");
  const appId = launch?.kind === "mcp" ? launch.args.appId : undefined;
  return typeof appId === "string" ? appId : APP_IDS[shot.profile.platform];
}

/** ProtoViewer app IDs installed on one pinned device, in `PROTOVIEWER_PACKAGES` order. */
async function installedProtoViewerIds(
  platform: Platform,
  pin: string,
  runner: CaptureRunner,
): Promise<string[]> {
  if (platform === "android") {
    // Seeding lists only the foreground user's packages (AndroidProtoViewer), so the probe does too.
    const current = await runner.run(["adb", "-s", pin, "shell", "am", "get-current-user"]);
    const userId = Number.parseInt(current.trim(), 10);
    if (!Number.isSafeInteger(userId) || userId < 0) {
      throw new Error(`Could not read the current Android user on ${pin}: ${current.trim()}`);
    }
    const listing = await runner.run([
      "adb",
      "-s",
      pin,
      "shell",
      "pm",
      "list",
      "packages",
      "--user",
      String(userId),
      PROTOVIEWER_PACKAGE,
    ]);
    return PROTOVIEWER_PACKAGES.filter((id) => packageListingContains(listing, id));
  }
  const found: string[] = [];
  for (const id of PROTOVIEWER_PACKAGES) {
    try {
      await runner.run(["xcrun", "simctl", "get_app_container", pin, id]);
      found.push(id);
    } catch (error) {
      // Only a not-installed answer means absent; any other failure could hide the build seeding uses.
      if (!isMissingIosAppError(errorMessage(error))) {
        throw error;
      }
      console.debug(`${id} not installed on ${pin}`);
    }
  }
  return found;
}

/**
 * `prototype` `save` imports into the installed ProtoViewer build the host prefers (`.dev` over the
 * store build, #14144), with no way to name one. When that is not the app the shots launch and
 * capture, the captured library would be empty (#18526), so refuse before any device step runs.
 */
export async function checkSeedTargets(
  shots: readonly ScreenshotShot[],
  pins: Partial<PlanPins>,
  runner: CaptureRunner,
): Promise<void> {
  const targets = new Map<Platform, string>();
  for (const shot of shots) {
    targets.set(shot.profile.platform, captureAppId(shot));
  }
  for (const [platform, captureId] of targets) {
    const pin = (platform === "android" ? pins.androidSerial : pins.iosUdid) ?? "";
    const installed = await installedProtoViewerIds(platform, pin, runner);
    const seedId = preferredProtoViewerPackage((id) => installed.includes(id));
    if (seedId === captureId) {
      continue;
    }
    const flag = platform === "android" ? "--android-app-id" : "--ios-app-id";
    throw new Error(
      seedId === undefined
        ? `No ProtoViewer build is installed on ${platform} device ${pin}; install ${captureId} before capturing`
        : `prototype save seeds ${seedId} on ${platform} device ${pin}, but the shots capture ${captureId}. ` +
            `Uninstall ${seedId} or pass ${flag} ${seedId} so the seeded library is the one captured`,
    );
  }
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
