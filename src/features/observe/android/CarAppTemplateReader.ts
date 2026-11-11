import type { BootedDevice, ObserveResult } from "../../../models";
import {
  ANDROID_AUTO_PACKAGE,
  CAR_APP_PROJECTED_NOTE,
  CAR_APP_TEMPLATES_NOTE,
  carAppTemplateDocumentSchema,
  type CarAppForegroundTemplates,
  type CarAppProjectedTemplates,
  type CarAppTemplateDocument,
  type CarAppTemplates,
} from "../../../models/CarAppTemplates";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { DUMPSYS_MAX_BUFFER } from "../../../utils/android-cmdline-tools/dumpsysLimits";
import { ANDROID_PACKAGE_NAME_PATTERN } from "../../../utils/androidPackageName";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { shellQuote } from "../../../utils/shellQuote";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";
import {
  ANDROID_AUTO_PROJECTION_NOTE,
  type AndroidAutoProjection,
} from "../../../models/AndroidAutoProjection";
import {
  parseAndroidAutoProjectionServices,
  type AndroidAutoProjectionServices,
} from "./projectedCarApps";

/**
 * Resolves the optional `carAppTemplates` block for an observation (#16751), or undefined when no
 * app answers the SDK route with an enabled snapshot. While Android Auto is the foreground app, the
 * apps it has bound are asked instead (#17826).
 */
export type CarAppTemplatesResolver = (
  device: BootedDevice,
  result: ObserveResult,
) => Promise<CarAppTemplates | undefined>;

/**
 * Resolves the optional `androidAuto` block (#17841) from an observation that already carries its
 * `carAppTemplates`, or undefined when Android Auto is not seen projecting.
 */
export type AndroidAutoProjectionResolver = (
  device: BootedDevice,
  result: ObserveResult,
) => Promise<AndroidAutoProjection | undefined>;

export type CarAppAdb = Pick<AdbExecutor, "executeCommand" | "getForegroundApp">;

/** observe awaits the block, so a slow or stuck provider must not hold the captured result. */
export const CAR_APP_TEMPLATES_TIMEOUT_MS = 1500;
/** An app without the route is asked again only after this long (it may be reinstalled with it). */
export const CAR_APP_ROUTE_ABSENT_TTL_MS = 5 * 60_000;
/** An app whose route answered disabled is asked again only after this long. */
export const CAR_APP_ROUTE_DISABLED_TTL_MS = 30_000;
/** A read that failed (timeout, adb error, bad payload) is retried after this short interval. */
export const CAR_APP_ROUTE_FAILED_RETRY_MS = 5_000;

/**
 * Back-to-back observations during projection reuse one `dumpsys activity services` read for this
 * long, so they do not re-dump every service on the device each time.
 */
export const CAR_APP_PROJECTED_SERVICES_TTL_MS = 1_000;

/**
 * The `error` of a projected app whose route answered enabled before but whose read failed now
 * (timeout, adb error, bad payload): its screen is unknown for this read, not gone.
 */
export const CAR_APP_ROUTE_READ_FAILED = "template_read_failed";

/** One package's read: an enabled block, a failed read, or nothing to report. */
type PackageRead =
  | { kind: "block"; block: CarAppForegroundTemplates }
  | { kind: "failed" }
  | { kind: "none" };

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
 * after a short interval. Overlapping observations of the same app share one read. While Android
 * Auto projects, its foreground package is not the projected app, so the apps bound by Android Auto
 * from `dumpsys activity services` are each read through the same per-package path.
 */
export class CarAppTemplateReader {
  private readonly quietUntil = new Map<string, number>();
  /** Quiet keys whose quiet interval follows a failed read, not an absent or disabled route. */
  private readonly failedReads = new Set<string>();
  /** Quiet keys (device, package, user) whose route last answered enabled. */
  private readonly answeredEnabled = new Set<string>();
  /** The Android user each device's package was last read as; the hint for skipping a lookup. */
  private readonly lastUser = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<PackageRead>>();
  /** Per device: the last successful services dump, parsed, or the dump still running. */
  /**
   * Per device: the services snapshot the last projected templates read used, the observation it
   * was taken for, and the bound apps (package and user) whose route answered, so the
   * `androidAuto` block of that observation uses the same snapshot even after the dump's TTL.
   */
  private readonly projectionSnapshots = new Map<
    string,
    { observationId: string; services: AndroidAutoProjectionServices; answered: Set<string> }
  >();
  private readonly projectionCache = new Map<
    string,
    { services: Promise<AndroidAutoProjectionServices | undefined>; until: number }
  >();

  constructor(
    private readonly adbFor: (device: BootedDevice) => CarAppAdb,
    private readonly timer: Timer = defaultTimer,
  ) {}

  /** Remembered quiet packages and user hints; expired entries are pruned on every write. */
  get quietEntryCount(): number {
    return this.quietUntil.size + this.lastUser.size;
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
    if (packageName === ANDROID_AUTO_PACKAGE) {
      return this.resolveProjected(device, result.observationId);
    }
    const read = await this.shared(device, packageName, result.userId, () =>
      this.resolveFor(device, packageName, result.userId),
    );
    // The foreground block is optional: a failed read omits it, as before.
    return read.kind === "block" ? read.block : undefined;
  };

  /** Overlapping reads of one device, user and package share one promise. */
  private shared(
    device: BootedDevice,
    packageName: string,
    userId: number | undefined,
    start: () => Promise<PackageRead>,
  ): Promise<PackageRead> {
    const key = `${device.deviceId}\u0000${userId ?? ""}\u0000${packageName}`;
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }
    const read = start().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, read);
    return read;
  }

  /**
   * Every app Android Auto has bound, read as the user its service runs as. Undefined when none
   * answers enabled, so the payload is unchanged.
   */
  private async resolveProjected(
    device: BootedDevice,
    observationId: string,
  ): Promise<CarAppTemplates | undefined> {
    this.projectionSnapshots.delete(device.deviceId);
    const { services, apps, blocks } = await this.readBoundApps(device);
    if (services) {
      const answered = new Set(
        apps.flatMap((app, index) => (blocks[index] ? [appUserKey(app)] : [])),
      );
      this.projectionSnapshots.set(device.deviceId, { observationId, services, answered });
    }
    return projectedTemplates(blocks);
  }

  /**
   * The projected apps' template stacks outside an observation, for head-unit actions (#17842):
   * the same reads as observe's projected block, without replacing the services snapshot an
   * observation in progress keeps for its `androidAuto` block.
   */
  async readProjected(device: BootedDevice): Promise<CarAppProjectedTemplates | undefined> {
    if (device.platform !== "android") {
      return undefined;
    }
    return projectedTemplates((await this.readBoundApps(device)).blocks);
  }

  private async readBoundApps(device: BootedDevice): Promise<{
    services: AndroidAutoProjectionServices | undefined;
    apps: AndroidAutoProjectionServices["apps"];
    blocks: (CarAppForegroundTemplates | undefined)[];
  }> {
    const services = await this.projectionServices(device);
    const apps = services?.apps ?? [];
    const reads = await Promise.all(
      apps.map((app) =>
        this.shared(device, app.packageName, app.userId, () =>
          this.readKnownUser(device, app.packageName, app.userId),
        ),
      ),
    );
    // A known car app whose read failed stays listed with an error, so a head-unit action reads
    // its screen as unknown instead of gone (#17911).
    const blocks = reads.map((read, index) => {
      if (read.kind === "block") {
        return read.block;
      }
      return read.kind === "failed" ? failedBlock(apps[index].packageName) : undefined;
    });
    return { services, apps, blocks };
  }

  /**
   * The `androidAuto` block while Android Auto is the foreground app and one of its Car App Library
   * template hosts is bound, which means a head unit session is hosting car app templates. Uses
   * the services snapshot {@link resolve} took for this same observation, never a second dump, and
   * is undefined without one. `apps` keeps the bound apps (package and user) whose route answered,
   * the only ones known to be Car App Library apps; none is marked visible, because a bound app
   * stays bound while another app is on the head unit (#17827).
   */
  readonly resolveAndroidAuto: AndroidAutoProjectionResolver = async (device, result) => {
    if (device.platform !== "android" || result.activeWindow?.appId !== ANDROID_AUTO_PACKAGE) {
      return undefined;
    }
    const snapshot = this.projectionSnapshots.get(device.deviceId);
    if (!snapshot || snapshot.observationId !== result.observationId) {
      return undefined;
    }
    const { services, answered } = snapshot;
    if (services.templateHosts.length === 0) {
      return undefined;
    }
    return {
      projecting: true,
      projectedBy: ANDROID_AUTO_PACKAGE,
      templateHosts: services.templateHosts,
      apps: services.apps
        .filter((app) => answered.has(appUserKey(app)))
        .map(({ packageName, userId, services: bound }) => ({
          packageName,
          userId,
          services: bound,
        })),
      note: ANDROID_AUTO_PROJECTION_NOTE,
    };
  };

  /**
   * The parsed services dump, reused for {@link CAR_APP_PROJECTED_SERVICES_TTL_MS}; overlapping
   * observations share the running dump. A failed dump is not cached, so the next observation dumps
   * again.
   */
  private async projectionServices(
    device: BootedDevice,
  ): Promise<AndroidAutoProjectionServices | undefined> {
    const now = this.timer.now();
    for (const [deviceId, entry] of this.projectionCache) {
      if (entry.until <= now) {
        this.projectionCache.delete(deviceId);
      }
    }
    const cached = this.projectionCache.get(device.deviceId);
    if (cached) {
      return cached.services;
    }
    const entry = { services: this.dumpProjection(device), until: Number.POSITIVE_INFINITY };
    this.projectionCache.set(device.deviceId, entry);
    const services = await entry.services;
    if (services === undefined) {
      this.projectionCache.delete(device.deviceId);
      return undefined;
    }
    entry.until = this.timer.now() + CAR_APP_PROJECTED_SERVICES_TTL_MS;
    return services;
  }

  /** One services dump, parsed; undefined when it failed. */
  private async dumpProjection(
    device: BootedDevice,
  ): Promise<AndroidAutoProjectionServices | undefined> {
    try {
      const result = await raceWithDeadline(
        () =>
          this.adbFor(device).executeCommand("shell dumpsys activity services", {
            timeoutMs: CAR_APP_TEMPLATES_TIMEOUT_MS,
            maxBuffer: DUMPSYS_MAX_BUFFER,
          }),
        {
          timer: this.timer,
          timeoutMs: CAR_APP_TEMPLATES_TIMEOUT_MS,
          unref: true,
          label: "bound car app services during Android Auto projection",
        },
      );
      return parseAndroidAutoProjectionServices(result.stdout);
    } catch (error) {
      // The blocks are optional; an unreadable services dump just omits them for this observation.
      logger.debug(`car app services dump failed during projection: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private async resolveFor(
    device: BootedDevice,
    packageName: string,
    observedUserId: number | undefined,
  ): Promise<PackageRead> {
    const appKey = `${device.deviceId}\u0000${packageName}`;
    const userId = observedUserId ?? (await this.lookUpUser(device, packageName, appKey));
    if (userId === undefined) {
      return { kind: "none" };
    }
    return this.readKnownUser(device, packageName, userId);
  }

  /**
   * Reads one package as one user, honouring and updating its quiet entry. A failed read of a
   * route that last answered enabled, or the retry interval after one, is `failed`; any other
   * quiet or non-enabled answer is `none`.
   */
  private async readKnownUser(
    device: BootedDevice,
    packageName: string,
    userId: number,
  ): Promise<PackageRead> {
    const appKey = `${device.deviceId}\u0000${packageName}`;
    const key = quietKey(appKey, userId);
    if (this.isQuiet(key)) {
      return this.failedReads.has(key) && this.answeredEnabled.has(key)
        ? { kind: "failed" }
        : { kind: "none" };
    }
    const answer = await this.read(device, packageName, userId);
    if (answer.kind !== "document" || !answer.document.enabled) {
      this.quiet(key, quietIntervalMs(answer));
      this.lastUser.set(appKey, userId);
      if (answer.kind === "failed") {
        this.failedReads.add(key);
        return this.answeredEnabled.has(key) ? { kind: "failed" } : { kind: "none" };
      }
      // The route is gone or disabled now, so a later failure is no longer a known app's.
      this.answeredEnabled.delete(key);
      return { kind: "none" };
    }
    this.quietUntil.delete(key);
    this.failedReads.delete(key);
    this.lastUser.delete(appKey);
    this.answeredEnabled.add(key);
    const { document } = answer;
    return {
      kind: "block",
      block: {
        packageName,
        source: "sdk",
        note: CAR_APP_TEMPLATES_NOTE,
        sessions: document.sessions,
        ...(document.error ? { error: document.error } : {}),
      },
    };
  }

  /**
   * The user to read as when the observation carries none. While the app's last-read user is still
   * quiet, or a lookup just failed, no lookup runs, so an app without the route still costs about
   * one adb call per TTL rather than a `dumpsys` on every observation.
   */
  private async lookUpUser(
    device: BootedDevice,
    packageName: string,
    appKey: string,
  ): Promise<number | undefined> {
    const hinted = this.lastUser.get(appKey);
    if (
      this.isQuiet(quietKey(appKey, UNKNOWN_USER)) ||
      (hinted !== undefined && this.isQuiet(quietKey(appKey, hinted)))
    ) {
      return undefined;
    }
    const userId = await this.foregroundUser(device, packageName);
    if (userId === undefined) {
      this.quiet(quietKey(appKey, UNKNOWN_USER), CAR_APP_ROUTE_FAILED_RETRY_MS);
    }
    return userId;
  }

  private isQuiet(key: string): boolean {
    return (this.quietUntil.get(key) ?? 0) > this.timer.now();
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
        this.failedReads.delete(entry);
      }
    }
    for (const [appKey, userId] of this.lastUser) {
      if (!this.quietUntil.has(quietKey(appKey, userId))) {
        this.lastUser.delete(appKey);
      }
    }
    this.quietUntil.set(key, now + intervalMs);
    this.failedReads.delete(key);
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

/** The projected block from each bound app's read, or undefined when none answered enabled. */
function projectedTemplates(
  blocks: readonly (CarAppForegroundTemplates | undefined)[],
): CarAppProjectedTemplates | undefined {
  const projected = blocks.flatMap((block) =>
    block
      ? [
          {
            packageName: block.packageName,
            sessions: block.sessions,
            ...(block.error ? { error: block.error } : {}),
          },
        ]
      : [],
  );
  if (projected.length === 0) {
    return undefined;
  }
  return {
    source: "sdk",
    note: CAR_APP_TEMPLATES_NOTE,
    projectedBy: ANDROID_AUTO_PACKAGE,
    projectedNote: CAR_APP_PROJECTED_NOTE,
    projected,
  };
}

/** A known car app whose read failed: listed with no sessions and an error. */
function failedBlock(packageName: string): CarAppForegroundTemplates {
  return {
    packageName,
    source: "sdk",
    note: CAR_APP_TEMPLATES_NOTE,
    sessions: [],
    error: CAR_APP_ROUTE_READ_FAILED,
  };
}

/** A bound app's package and Android user, as one key. */
function appUserKey(app: { packageName: string; userId: number }): string {
  return `${app.packageName}\u0000${app.userId}`;
}

/** Quiet-map user segment for a foreground lookup that named no usable user. */
const UNKNOWN_USER = "?";

function quietKey(appKey: string, userId: number | typeof UNKNOWN_USER): string {
  return `${appKey}\u0000${userId}`;
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
