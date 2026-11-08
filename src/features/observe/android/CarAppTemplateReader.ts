import type { BootedDevice, ObserveResult } from "../../../models";
import {
  CAR_APP_TEMPLATES_NOTE,
  carAppTemplateDocumentSchema,
  type CarAppTemplateDocument,
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

export type CarAppAdb = Pick<AdbExecutor, "executeCommand" | "getForegroundApp">;

/** observe awaits the block, so a slow or stuck provider must not hold the captured result. */
export const CAR_APP_TEMPLATES_TIMEOUT_MS = 1500;
/** An app without the route is asked again only after this long (it may be reinstalled with it). */
export const CAR_APP_ROUTE_ABSENT_TTL_MS = 5 * 60_000;
/** An app whose route answered disabled is asked again only after this long. */
export const CAR_APP_ROUTE_DISABLED_TTL_MS = 30_000;
/** A read that failed (timeout, adb error, bad payload) is retried after this short interval. */
export const CAR_APP_ROUTE_FAILED_RETRY_MS = 5_000;

/** The route's answer: a snapshot document, no route at all, or a read that failed. */
export type CarAppRouteRead =
  | { kind: "document"; document: CarAppTemplateDocument }
  | { kind: "absent" }
  | { kind: "failed" };

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
 * Reads the snapshot with `adb shell content call` as the foreground app's Android user. A package
 * that has no route, or whose route answered disabled, is remembered per device, user and package
 * so ordinary observations pay for at most one call per package per TTL; a failed read is retried
 * after a short interval. Overlapping observations of the same app share one read.
 */
export class CarAppTemplateReader {
  private readonly quietUntil = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<CarAppTemplates | undefined>>();

  constructor(
    private readonly adbFor: (device: BootedDevice) => CarAppAdb,
    private readonly timer: Timer = defaultTimer,
  ) {}

  /** Remembered quiet packages; expired entries are pruned on every write. */
  get quietEntryCount(): number {
    return this.quietUntil.size;
  }

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
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }
    const read = this.resolveFor(device, packageName, result.userId).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, read);
    return read;
  };

  private async resolveFor(
    device: BootedDevice,
    packageName: string,
    observedUserId: number | undefined,
  ): Promise<CarAppTemplates | undefined> {
    const userId = observedUserId ?? (await this.foregroundUser(device, packageName));
    if (userId === undefined) {
      return undefined;
    }
    const key = `${device.deviceId}\u0000${userId}\u0000${packageName}`;
    if ((this.quietUntil.get(key) ?? 0) > this.timer.now()) {
      return undefined;
    }
    const answer = await this.read(device, packageName, userId);
    if (answer.kind !== "document" || !answer.document.enabled) {
      this.quiet(key, quietIntervalMs(answer));
      return undefined;
    }
    this.quietUntil.delete(key);
    const { document } = answer;
    return {
      packageName,
      source: "sdk",
      note: CAR_APP_TEMPLATES_NOTE,
      sessions: document.sessions,
      ...(document.error ? { error: document.error } : {}),
    };
  }

  /**
   * observe does not carry the Android user, so read it from the foreground lookup. A lookup that
   * names another package (the foreground moved) skips the read rather than guessing user 0.
   */
  private async foregroundUser(
    device: BootedDevice,
    packageName: string,
  ): Promise<number | undefined> {
    try {
      const foreground = await raceWithDeadline(
        () => this.adbFor(device).getForegroundApp(undefined, CAR_APP_TEMPLATES_TIMEOUT_MS),
        {
          timer: this.timer,
          timeoutMs: CAR_APP_TEMPLATES_TIMEOUT_MS,
          unref: true,
          label: `foreground user for car app templates of ${packageName}`,
        },
      );
      return foreground?.packageName === packageName ? foreground.userId : undefined;
    } catch (error) {
      // The block is optional; an unreadable foreground just omits it for this observation.
      logger.debug(
        `car app template foreground lookup failed for ${packageName}: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  private quiet(key: string, intervalMs: number): void {
    const now = this.timer.now();
    for (const [entry, until] of this.quietUntil) {
      if (until <= now) {
        this.quietUntil.delete(entry);
      }
    }
    this.quietUntil.set(key, now + intervalMs);
  }

  private async read(
    device: BootedDevice,
    packageName: string,
    userId: number,
  ): Promise<CarAppRouteRead> {
    const uri = `content://${packageName}.automobile.carapptemplates`;
    const command = `shell content call --user ${userId} --uri ${shellQuote(uri)} --method snapshot`;
    let output: string;
    try {
      const result = await raceWithDeadline(
        () =>
          this.adbFor(device).executeCommand(command, { timeoutMs: CAR_APP_TEMPLATES_TIMEOUT_MS }),
        {
          timer: this.timer,
          timeoutMs: CAR_APP_TEMPLATES_TIMEOUT_MS,
          unref: true,
          label: `car app template snapshot for ${packageName}`,
        },
      );
      output = `${result.stdout}\n${result.stderr}`;
    } catch (error) {
      const message = errorMessage(error);
      if (PROVIDER_MISSING_PATTERN.test(message)) {
        // Most apps do not integrate the SDK route, so a missing provider is the normal answer.
        logger.debug(`car app template route unavailable for ${packageName}: ${message}`);
        return { kind: "absent" };
      }
      // A timeout or adb error is retried shortly; the block is optional for this observation.
      logger.debug(`car app template read failed for ${packageName}: ${message}`);
      return { kind: "failed" };
    }
    return parseRouteOutput(packageName, output);
  }
}

/** `content call` against an authority no installed provider claims. */
const PROVIDER_MISSING_PATTERN = /Could not find provider|Unknown authority/i;

function quietIntervalMs(answer: CarAppRouteRead): number {
  switch (answer.kind) {
    case "document":
      return CAR_APP_ROUTE_DISABLED_TTL_MS;
    case "absent":
      return CAR_APP_ROUTE_ABSENT_TTL_MS;
    case "failed":
      return CAR_APP_ROUTE_FAILED_RETRY_MS;
  }
}

function parseRouteOutput(packageName: string, output: string): CarAppRouteRead {
  if (PROVIDER_MISSING_PATTERN.test(output)) {
    logger.debug(`car app template route unavailable for ${packageName}`);
    return { kind: "absent" };
  }
  let payload: unknown;
  try {
    payload = parseCarAppTemplateCallOutput(output);
  } catch (error) {
    logger.warn(
      `car app template route for ${packageName} returned unparseable JSON: ${errorMessage(error)}`,
    );
    return { kind: "failed" };
  }
  if (payload === undefined) {
    // `Result: null`: the provider exists but does not answer the snapshot method.
    logger.debug(`car app template route unavailable for ${packageName}: no result`);
    return { kind: "absent" };
  }
  const parsed = carAppTemplateDocumentSchema.safeParse(payload);
  if (!parsed.success) {
    logger.warn(
      `car app template route for ${packageName} failed schema validation: ${parsed.error.message}`,
    );
    return { kind: "failed" };
  }
  return { kind: "document", document: parsed.data };
}
