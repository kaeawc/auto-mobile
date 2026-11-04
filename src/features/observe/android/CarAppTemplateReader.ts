import type { BootedDevice, ObserveResult } from "../../../models";
import {
  CAR_APP_TEMPLATES_NOTE,
  carAppTemplateDocumentSchema,
  type CarAppTemplates,
} from "../../../models/CarAppTemplates";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { ANDROID_PACKAGE_NAME_PATTERN } from "../../../utils/androidPackageName";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { shellQuote } from "../../../utils/shellQuote";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";

/**
 * Resolves the optional `carAppTemplates` block for an observation (#16751), or undefined when the
 * foreground app does not answer the SDK route with an enabled snapshot.
 */
export type CarAppTemplatesResolver = (
  device: BootedDevice,
  result: ObserveResult,
) => Promise<CarAppTemplates | undefined>;

export type CarAppAdb = Pick<AdbExecutor, "executeCommand">;

/** observe awaits the block, so a slow or stuck provider must not hold the captured result. */
export const CAR_APP_TEMPLATES_TIMEOUT_MS = 1500;
/** An app without the route is asked again only after this long (it may be reinstalled with it). */
export const CAR_APP_ROUTE_ABSENT_TTL_MS = 5 * 60_000;
/** An app whose route answered disabled is asked again only after this long. */
export const CAR_APP_ROUTE_DISABLED_TTL_MS = 30_000;

/** Parses `content call` output: `Result: Bundle[{result=<json>}]`. */
export function parseCarAppTemplateCallOutput(output: string): unknown {
  const start = output.indexOf("result=");
  const end = output.lastIndexOf("}]");
  if (start === -1 || end === -1 || end < start) {
    return undefined;
  }
  return JSON.parse(output.slice(start + "result=".length, end));
}

/**
 * Reads the snapshot with `adb shell content call`. A package that has no route, or whose route
 * answered disabled, is remembered per device so ordinary observations pay for at most one call per
 * package per TTL.
 */
export class CarAppTemplateReader {
  private readonly quietUntil = new Map<string, number>();

  constructor(
    private readonly adbFor: (device: BootedDevice) => CarAppAdb,
    private readonly timer: Timer = defaultTimer,
  ) {}

  readonly resolve: CarAppTemplatesResolver = async (device, result) => {
    const packageName = result.activeWindow?.appId;
    if (
      device.platform !== "android" ||
      !packageName ||
      !ANDROID_PACKAGE_NAME_PATTERN.test(packageName)
    ) {
      return undefined;
    }
    const key = `${device.deviceId}\u0000${result.userId ?? ""}\u0000${packageName}`;
    if ((this.quietUntil.get(key) ?? 0) > this.timer.now()) {
      return undefined;
    }
    const document = await this.read(device, packageName, result.userId);
    if (!document?.enabled) {
      this.quietUntil.set(
        key,
        this.timer.now() + (document ? CAR_APP_ROUTE_DISABLED_TTL_MS : CAR_APP_ROUTE_ABSENT_TTL_MS),
      );
      return undefined;
    }
    this.quietUntil.delete(key);
    return {
      packageName,
      source: "sdk",
      note: CAR_APP_TEMPLATES_NOTE,
      sessions: document.sessions,
      ...(document.error ? { error: document.error } : {}),
    };
  };

  private async read(device: BootedDevice, packageName: string, userId: number | undefined) {
    const uri = `content://${packageName}.automobile.carapptemplates`;
    const user = userId === undefined ? "" : ` --user ${userId}`;
    const command = `shell content call${user} --uri ${shellQuote(uri)} --method snapshot`;
    try {
      const output = await raceWithDeadline(
        () =>
          this.adbFor(device).executeCommand(command, { timeoutMs: CAR_APP_TEMPLATES_TIMEOUT_MS }),
        {
          timer: this.timer,
          timeoutMs: CAR_APP_TEMPLATES_TIMEOUT_MS,
          unref: true,
          label: `car app template snapshot for ${packageName}`,
        },
      );
      const parsed = carAppTemplateDocumentSchema.safeParse(
        parseCarAppTemplateCallOutput(`${output.stdout}\n${output.stderr}`),
      );
      return parsed.success ? parsed.data : undefined;
    } catch (error) {
      // Most apps do not integrate the SDK route, so a failed provider call is the normal answer.
      logger.debug(`car app template route unavailable for ${packageName}: ${errorMessage(error)}`);
      return undefined;
    }
  }
}
