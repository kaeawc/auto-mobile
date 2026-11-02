import type { BootedDevice } from "../../models";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type {
  DeviceConditionApplyOutcome,
  DeviceConditionInjector,
} from "./DeviceConditionController";
import type { DeviceConditionKey } from "./DeviceConditionTypes";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import { SelinuxOwner, resolveSelinuxOwner, selinuxOwnersByDevice } from "./SelinuxOwner";
import { ArtifactOwner, artifactOwnersByDevice, resolveArtifactOwner } from "./ArtifactOwner";
import {
  DefaultMagiskStubBuilder,
  MAGISK_PACKAGE,
  createMagiskPackageArtifact,
  type MagiskStubBuilder,
} from "./magiskStub";
import { OwedResetError } from "./OwedResetError";
import { adbCommand, rejectValue, shell } from "./injectorSupport";

/**
 * `deviceCondition.rootState` (#14060): make a non-Play emulator present as rooted
 * for detection testing. This is a detectable fixture, not working privilege
 * escalation: the planted `su`/`busybox` are inert stubs that trip file-based
 * RootBeer/Talsec checks, with SELinux set permissive. Google Play images refuse
 * `adb root`, so they are refused up front with a pointer to real root (#14070).
 */
export const ROOTED_DETECTABLE = "rooted-detectable";

/** Files planted on the writable system partition; reset removes exactly these. */
export const ROOT_ARTIFACT_PATHS = [
  "/system/xbin/su",
  "/system/bin/su",
  "/system/xbin/busybox",
  "/system/bin/busybox",
  "/system/app/Superuser.apk",
] as const;

const MAGISK_MARKER = "/data/local/tmp/automobile-rootstate-magisk";

const STUB_SCRIPT = "#!/system/bin/sh\\nexit 1\\n";

/** A Play image is a production build: not debuggable, and `adb root` is refused. */
export async function assertRootableImage(
  adb: AdbExecutor,
  signal?: AbortSignal,
  key = "rootState",
): Promise<void> {
  const debuggable = await shell(adb, ["getprop", "ro.debuggable"], signal);
  const buildType = await shell(adb, ["getprop", "ro.build.type"], signal);
  if (debuggable !== "1" || buildType === "user") {
    throw new ActionableError(
      `${key} needs a non-Play image (google_apis, default or aosp): this device is a production ` +
        `build (ro.debuggable=${debuggable || "?"}, ro.build.type=${buildType || "?"}) and refuses adb root. ` +
        "For real root on a Play image, use the rootAVD/Magisk fixture (#14070).",
    );
  }
}

/** Start root adbd and wait for its restarted transport; refusal may exit successfully. */
export async function ensureRootAdb(adb: AdbExecutor, signal?: AbortSignal): Promise<void> {
  const output = await adbCommand(adb, ["root"], signal);
  if (/cannot run as root|not allowed|refused|permission denied/i.test(output)) {
    throw new ActionableError(`adb root refused: ${output}`);
  }
  await adbCommand(adb, ["wait-for-device"], signal);
}

/** `adb remount`, refusing with guidance when /system stays read-only. */
async function remountSystem(adb: AdbExecutor, signal?: AbortSignal): Promise<void> {
  let out: string;
  try {
    out = await adbCommand(adb, ["remount"], signal);
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    // A refused remount exits nonzero; keep the boot-writable guidance instead of the bare adb error.
    throw new ActionableError(
      `adb remount failed (${errorMessage(error)}). Boot the AVD with ` +
        "-writable-system, or run `adb disable-verity` and reboot first.",
    );
  }
  if (
    /remount failed|verity|not permitted|read-only/i.test(out) &&
    !/remount succeeded/i.test(out)
  ) {
    throw new ActionableError(
      `adb remount did not make /system writable (${out.split("\n")[0]}). Boot the AVD with ` +
        "-writable-system, or run `adb disable-verity` and reboot first.",
    );
  }
}

export async function remountWritable(adb: AdbExecutor, signal?: AbortSignal): Promise<void> {
  await ensureRootAdb(adb, signal);
  await remountSystem(adb, signal);
}

export async function plantArtifacts(
  adb: AdbExecutor,
  paths: readonly string[],
  planted: Set<string>,
  signal?: AbortSignal,
): Promise<void> {
  for (const path of paths) {
    // Recorded before the write so a half-planted file is still removed by the rollback.
    planted.add(path);
    // adb joins these with spaces for the device shell, so the script must be one quoted word.
    await shell(adb, ["printf", shellQuote(STUB_SCRIPT), ">", path], signal);
    await shell(adb, ["chmod", path.endsWith(".apk") ? "0644" : "06755", path], signal);
  }
}

/**
 * Which of `paths` exist. `ls` exits nonzero when ANY operand is missing even though it still
 * lists the ones that exist, and the adb client rejects a nonzero exit, so `; true` keeps the
 * partial listing. A read that genuinely fails (transport error) throws instead of reading as
 * "none exist".
 */
export async function listExisting(
  adb: AdbExecutor,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  if (paths.length === 0) {
    return new Set();
  }
  // A failed listing throws: reading it as "none exist" would let apply overwrite a real file.
  const out = await shell(adb, ["ls", ...paths, "2>/dev/null;", "true"], signal);
  return new Set(
    out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
}

function rootArtifactLister(
  adb: AdbExecutor,
  magisk: ReturnType<typeof createMagiskPackageArtifact>,
): (paths: string[], signal?: AbortSignal) => Promise<Set<string>> {
  return async (paths: string[], signal?: AbortSignal): Promise<Set<string>> => {
    const existing = await listExisting(
      adb,
      paths.filter((path) => path !== magisk.key),
      signal,
    );
    if (paths.includes(magisk.key) && (await magisk.present(signal))) {
      existing.add(magisk.key);
    }
    return existing;
  };
}

async function rootStateIsClean(
  adb: AdbExecutor,
  owner: {
    held: Set<string>;
    artifacts: ArtifactOwner;
    artifactToken: object;
    selinux: SelinuxOwner;
    selinuxToken: object;
  },
  listArtifacts: (paths: string[], signal?: AbortSignal) => Promise<Set<string>>,
  signal?: AbortSignal,
): Promise<boolean> {
  const owed = [...owner.held].filter((path) =>
    owner.artifacts.removableBy(owner.artifactToken, path),
  );
  if (owed.length > 0) {
    try {
      if ((await listArtifacts(owed, signal)).size > 0) {
        return false;
      }
    } catch (error) {
      if (signal?.aborted) {
        throw toActionableError(error, "rootState clean check aborted");
      }
      // A read that cannot run cannot show the device is clean, so report it as not clean.
      logger.warn(`rootState clean check could not list artifacts: ${errorMessage(error)}`, error);
      return false;
    }
  }
  return !owner.selinux.has(owner.selinuxToken) && (await owner.selinux.isClean(adb, signal));
}

interface RootStateOwner {
  held: Set<string>;
  planted: Set<string>;
  artifacts: ArtifactOwner;
  artifactToken: object;
  selinux: SelinuxOwner;
  selinuxToken: object;
  packageArtifact: string;
}

/** Recover unclaimed exact file stubs and a package whose fixture marker was verified. */
async function recoverRootArtifacts({
  adb,
  owner,
  existing,
  signal,
  markedPackage,
}: {
  adb: AdbExecutor;
  owner: RootStateOwner;
  existing: Set<string>;
  signal?: AbortSignal;
  markedPackage?: string;
}): Promise<string[]> {
  const matches: string[] = [];
  const candidates = ROOT_ARTIFACT_PATHS.filter(
    (path) =>
      existing.has(path) &&
      !owner.held.has(path) &&
      !owner.artifacts.heldByOther(owner.artifactToken, path),
  );
  for (const path of candidates) {
    // Keep raw stdout: shell() trims whitespace that distinguishes a real file from our stub.
    const result = await adb.execute(["shell", "cat", path], { signal });
    if (result.error) {
      throw new ActionableError(`rootState could not read ${path}: ${result.error}`);
    }
    const content = result.stdout.replace(/\r\n?/g, "\n");
    const stub = STUB_SCRIPT.replaceAll("\\n", "\n");
    if (content === stub || content === stub.slice(0, -1)) {
      matches.push(path);
    }
  }
  if (
    markedPackage &&
    !owner.held.has(markedPackage) &&
    !owner.artifacts.heldByOther(owner.artifactToken, markedPackage)
  ) {
    matches.push(markedPackage);
  }
  if (matches.length > 0) {
    await owner.selinux.recover(owner.selinuxToken);
    for (const path of matches) {
      owner.artifacts.plant(owner.artifactToken, path);
      owner.held.add(path);
      owner.planted.add(path);
    }
  }
  return matches;
}

async function readMarkedPackage(
  adb: AdbExecutor,
  packageArtifact: string,
  existing: Set<string>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!existing.has(packageArtifact)) {
    return undefined;
  }
  try {
    if ((await listExisting(adb, [MAGISK_MARKER], signal)).has(MAGISK_MARKER)) {
      return packageArtifact;
    }
  } catch (error) {
    // Without a readable marker we cannot distinguish the fixture from real Magisk.
    logger.warn(`rootState package marker probe failed: ${errorMessage(error)}`, error);
  }
  return undefined;
}

async function writeMagiskMarker(adb: AdbExecutor, signal?: AbortSignal): Promise<void> {
  await shell(adb, ["touch", shellQuote(MAGISK_MARKER)], signal);
}

async function applyMarkedPackage(
  adb: AdbExecutor,
  owner: RootStateOwner,
  magisk: ReturnType<typeof createMagiskPackageArtifact>,
  { hadPackage, signal }: { hadPackage: boolean; signal?: AbortSignal },
): Promise<void> {
  let plantedPackage = false;
  await magisk.apply(
    hadPackage,
    (planted) => {
      plantedPackage = planted;
      owner.artifacts[planted ? "plant" : "hold"](owner.artifactToken, owner.packageArtifact);
      owner.held.add(owner.packageArtifact);
    },
    signal,
  );
  if (plantedPackage) {
    await writeMagiskMarker(adb, signal);
  }
}

async function removeMarkedPackage(
  adb: AdbExecutor,
  magisk: ReturnType<typeof createMagiskPackageArtifact>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (await magisk.remove(signal)) {
    return true;
  }
  // Keep the recovery evidence until PackageManager confirms the package is gone.
  await shell(adb, ["rm", "-f", shellQuote(MAGISK_MARKER)], signal);
  return false;
}

async function discoverLeftovers(
  adb: AdbExecutor,
  owner: RootStateOwner,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  // Batch package discovery with the file listing: a clean device needs one shell read.
  const existing = owner.held.has(owner.packageArtifact)
    ? await listExisting(adb, paths, signal)
    : new Set(
        (
          await shell(
            adb,
            ["ls", ...paths, "2>/dev/null;", "pm", "list", "packages", MAGISK_PACKAGE],
            signal,
          )
        )
          .split("\n")
          .filter((line) => line !== ""),
      );
  const markedPackage = await readMarkedPackage(adb, owner.packageArtifact, existing, signal);
  await recoverRootArtifacts({ adb, owner, existing, signal, markedPackage });
}

async function probeLeftovers(
  adb: AdbExecutor,
  owner: RootStateOwner,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  try {
    await discoverLeftovers(adb, owner, paths, signal);
  } catch (error) {
    // The reset sweep is best-effort; cleanup still runs for artifacts already owned.
    logger.warn(`rootState recovery probe failed: ${errorMessage(error)}`, error);
  }
}

export function createRootStateInjector(
  adb: AdbExecutor,
  selinux = new SelinuxOwner(),
  artifacts = new ArtifactOwner(),
  stubBuilder: MagiskStubBuilder = new DefaultMagiskStubBuilder(),
): DeviceConditionInjector {
  const magisk = createMagiskPackageArtifact(adb, stubBuilder);
  const packageArtifact = magisk.key;
  const listArtifacts = rootArtifactLister(adb, magisk);
  const selinuxToken = {};
  const artifactToken = {};
  // Every artifact this fixture depends on, planted here or already present. Shared with
  // integrityState through `artifacts`, so neither deletes a stub the other still needs (#16275).
  const held = new Set<string>();
  // True while this fixture is applied and its reset is owed; a repeat apply is then coalesced.
  let active = false;
  // Only artifacts we planted or recognised by exact stub content or the package marker. A real userdebug su
  // is never overwritten or deleted by reset.
  const planted = new Set<string>();
  const owner: RootStateOwner = {
    held,
    planted,
    artifacts,
    artifactToken,
    selinux,
    selinuxToken,
    packageArtifact,
  };
  // One reset serves every apply, so repeat applies never stack separate cleanups. It is
  // defined here, before any mutation, so every later failure can undo it.
  const reset = async (resetSignal?: AbortSignal, sweep = true): Promise<void> => {
    if (sweep) {
      await probeLeftovers(
        adb,
        owner,
        ROOT_ARTIFACT_PATHS.filter((path) => !held.has(path)),
        resetSignal,
      );
    }
    if (held.size === 0 && !selinux.has(selinuxToken)) {
      return;
    }
    // Re-acquire the privileges the cleanup needs: an earlier reset (or a reboot) may
    // have un-rooted adbd. `adb root` is a no-op when it is already running as root.
    await ensureRootAdb(adb, resetSignal);
    const remaining = new Set<string>();
    // Planted by a fixture (here or by integrityState) and needed by no other fixture.
    const removable = [...held].filter((path) => artifacts.removableBy(artifactToken, path));
    const removableFiles = removable.filter((path) => path !== packageArtifact);
    if (removableFiles.length > 0) {
      // A reboot can return /system to read-only while the planted files survive.
      await remountSystem(adb, resetSignal);
      await shell(adb, ["rm", "-f", ...removableFiles], resetSignal);
      // Confirm the removal; the holds are only released once the files are really gone.
      for (const path of await listExisting(adb, removableFiles, resetSignal)) {
        remaining.add(path);
      }
    }
    if (
      removable.includes(packageArtifact) &&
      (await removeMarkedPackage(adb, magisk, resetSignal))
    ) {
      remaining.add(packageArtifact);
    }
    await selinux.release(adb, selinuxToken, resetSignal);
    await adbCommand(adb, ["unroot"], resetSignal);
    if (remaining.size > 0) {
      // Everything else is restored, but the reset stays owed so release retries and reports it.
      throw new ActionableError(
        `rootState reset left artifacts on the device: ${[...remaining].join(", ")}`,
      );
    }
    for (const path of held) {
      artifacts.release(artifactToken, path);
    }
    held.clear();
    planted.clear();
    active = false;
  };
  const recoverReset = async (signal?: AbortSignal) => {
    // A live apply already gave its controller the reset; another caller cannot take it.
    if (active) {
      return null;
    }
    await discoverLeftovers(adb, owner, ROOT_ARTIFACT_PATHS, signal);
    return held.size > 0 || selinux.has(selinuxToken)
      ? (resetSignal?: AbortSignal) => reset(resetSignal, false)
      : null;
  };
  // Every artifact the fixture depends on, not only those it planted: a file another fixture
  // planted can be removed under it.
  const artifactsStillThere = async (signal?: AbortSignal): Promise<boolean> => {
    const existing = await listArtifacts([...held], signal);
    return [...held].every((path) => existing.has(path));
  };
  // After a reboot that keeps the modified system image the files survive but SELinux is back
  // to Enforcing, so "already applied" has to check the mode as well as the files.
  const selinuxStillPermissive = async (signal?: AbortSignal): Promise<boolean> =>
    !selinux.has(selinuxToken) || /permissive/i.test(await shell(adb, ["getenforce"], signal));
  return {
    key: "rootState",
    recover: recoverReset,
    async apply(value, signal): Promise<DeviceConditionApplyOutcome> {
      if (value !== ROOTED_DETECTABLE) {
        rejectValue("rootState", value, [ROOTED_DETECTABLE]);
      }
      await assertRootableImage(adb, signal);
      const wasActive = active;
      if (
        wasActive &&
        (await artifactsStillThere(signal)) &&
        (await selinuxStillPermissive(signal))
      ) {
        return { status: "unchanged", detail: "rooted-detectable fixture is already applied" };
      }
      // Discovery happens before the first mutation, so a failed probe changes nothing.
      const existing = await listArtifacts([...ROOT_ARTIFACT_PATHS, packageArtifact], signal);
      const hadPackage = existing.has(packageArtifact);
      const markedPackage = await readMarkedPackage(adb, packageArtifact, existing, signal);
      const leftovers = await recoverRootArtifacts({ adb, owner, existing, signal, markedPackage });
      await selinux.capture(adb, selinuxToken, signal);
      const toPlant = ROOT_ARTIFACT_PATHS.filter((path) => !existing.has(path));
      try {
        await remountWritable(adb, signal);
        await selinux.set(adb, selinuxToken, true, signal);
        // Registered before the writes, so a rollback after a half-planted file removes it.
        for (const path of ROOT_ARTIFACT_PATHS) {
          if (toPlant.includes(path)) {
            artifacts.plant(artifactToken, path);
          } else {
            artifacts.hold(artifactToken, path);
          }
          held.add(path);
        }
        await plantArtifacts(adb, toPlant, planted, signal);
        await applyMarkedPackage(adb, owner, magisk, { hadPackage, signal });
      } catch (error) {
        try {
          await reset();
        } catch (cleanupError) {
          logger.warn(`rootState rollback failed: ${errorMessage(cleanupError)}`, cleanupError);
          throw new OwedResetError(
            `${errorMessage(error)} Cleanup also failed (${errorMessage(cleanupError)}); the device may still be rooted, and release will retry.`,
            reset,
            { cause: error },
          );
        }
        throw toActionableError(error, "Could not apply rootState fixture");
      }
      active = true;
      if (wasActive) {
        // The reset registered by the original apply still covers this fixture.
        return { status: "applied", detail: "rooted-detectable fixture re-applied after drift" };
      }
      const kept = ROOT_ARTIFACT_PATHS.filter(
        (path) => existing.has(path) && !leftovers.includes(path),
      ).length;
      return {
        status: "applied",
        detail:
          kept > 0
            ? `rooted-detectable fixture planted (${kept} artifact(s) already present on the image were left as-is)`
            : "rooted-detectable fixture planted",
        reset,
      };
    },
    isClean: (signal) => rootStateIsClean(adb, owner, listArtifacts, signal),
  };
}

/** One injector per device, so repeat applies share the baseline and the applied flag. */
const injectorsByDevice = new Map<string, DeviceConditionInjector>();

/**
 * The `rootState` injector for an Android device, or undefined for any other key or
 * platform. The same instance serves every apply on a device; tests pass their own cache.
 */
export function resolveRootStateInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
  options:
    | Map<string, DeviceConditionInjector>
    | {
        cache: Map<string, DeviceConditionInjector>;
        selinuxOwners?: Map<string, SelinuxOwner>;
        artifactOwners?: Map<string, ArtifactOwner>;
        stubBuilder?: MagiskStubBuilder;
      } = injectorsByDevice,
): DeviceConditionInjector | undefined {
  if (device.platform !== "android" || key !== "rootState") {
    return undefined;
  }
  const cache = options instanceof Map ? options : options.cache;
  const selinuxOwners = options instanceof Map ? selinuxOwnersByDevice : options.selinuxOwners;
  const artifactOwners = options instanceof Map ? artifactOwnersByDevice : options.artifactOwners;
  let injector = cache.get(device.deviceId);
  if (!injector) {
    injector = createRootStateInjector(
      adbFactory.create(device),
      resolveSelinuxOwner(device.deviceId, selinuxOwners),
      resolveArtifactOwner(device.deviceId, artifactOwners),
      options instanceof Map ? undefined : options.stubBuilder,
    );
    cache.set(device.deviceId, injector);
  }
  return injector;
}
