import { guardDirectoryEntries, readGuardFile } from "./astGuard";
import { beforeAll, describe, expect, test } from "bun:test";

import { join, relative, sep } from "node:path";
import { blankComments } from "./blankComments";

/**
 * FUNNEL 1 guard: every Android device discovery that is then joined to POOLED
 * IDENTITY must fold its observation into the pool first, through the single
 * method `DevicePool.reconcileDiscoveryObservation` (or the
 * `daemon/discoveryReconcile.ts` wrapper that resolves the pool for callers
 * outside it).
 *
 * Why a source scan rather than a type: the funnel is an ORDERING obligation
 * ("reconcile before you read pool state"), which no signature can express. It
 * regressed exactly that way before — `resolvePoolDeviceContext` withheld the
 * booted-devices resource's OWN output when discovery returned the
 * `Unknown (<serial>)` placeholder, while the pool itself never learned of it, so
 * the admission gate and every stream resolver went on trusting the stale label
 * until an unrelated allocation happened to reconcile
 * ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
 *
 * The allowlist below is the inventory of discovery call sites in `src/`, keyed
 * on file with an exact COUNT and a reason. A new call site — in a new file or an
 * allowlisted one — fails here, and the fix is to either route it through the
 * funnel or extend the entry with why it cannot be (typically: it runs outside
 * the daemon, or it never consults pooled identity).
 */
describe("Android discovery reconcile funnel (issue #6863)", () => {
  const ROOT = join(import.meta.dir, "..", "..");
  const SRC = join(ROOT, "src");
  // The source-tree inventory can exceed Bun's default hook limit on loaded CI runners.
  const TREE_SCAN_HOOK_TIMEOUT_MS = 20_000;

  /** The producer/consumer APIs that constitute "a device discovery". */
  const DISCOVERY_CALL =
    /\b(?:getBootedDevicesDetailed|getBootedDevices|getBootedAndroidDevices|getBootedDevicesChecked)\s*\(/g;

  /**
   * Shared prefix of every discovery API above. Matching it against the raw
   * BYTES skips decoding — and then scanning — the ~10MB of `src/` that names no
   * discovery API at all, which is what kept this scan inside the 100ms
   * per-test budget.
   */
  const DISCOVERY_PREFIX = "getBooted";

  interface Allowed {
    /** Exact number of discovery calls in the file. */
    readonly calls: number;
    /** Why these calls are allowed to exist where they are. */
    readonly reason: string;
  }

  /**
   * Every file in `src/` that calls a discovery API, and what it does about the
   * funnel. Keys are POSIX-style paths relative to the repository root.
   */
  const ALLOWLIST: Readonly<Record<string, Allowed>> = {
    // --- The funnel itself, and its producers -------------------------------
    "src/daemon/devicePoolParts/assignment.ts": {
      calls: 1,
      reason:
        "The pool routes discovery through the identity collaborator before reading pooled identity. " +
        "The second (readLiveInventoryDeviceIds, #11568) only collects the listed device ids for the " +
        "stats surfaces' live set; it reads cached discovery and never consults pooled identity.",
    },
    "src/daemon/devicePoolParts/emulatorLifecycle.ts": {
      calls: 1,
      reason:
        "Recovery discovery moved from DevicePool; the identity collaborator reconciles before pooled identity is read.",
    },
    "src/daemon/deviceAutoStart.ts": {
      calls: 2,
      reason:
        "Auto-start discovery moved from devicePool (#11807): candidate selection checks booted " +
        "images to avoid duplicate starts, and adoption checks whether an unlaunched emulator is " +
        "visible to this adb and whose foreign lease it carries before readiness. Neither call " +
        "joins discovery to pooled identity.",
    },
    "src/daemon/devicePoolRefresh.ts": {
      calls: 1,
      reason:
        "Refresh discovery moved from devicePool; observations still fold through the pool identity port.",
    },
    "src/daemon/deviceRuntimeIdentity.ts": {
      calls: 1,
      reason:
        "Bounded AVD-name rediscovery moved from devicePool; it reconciles observations through the identity collaborator.",
    },
    "src/daemon/missingDeviceLiveness.ts": {
      calls: 1,
      reason:
        "Assignment-time liveness discovery moved from devicePool; reused Android serials reconcile through the pool port.",
    },
    "src/daemon/deviceDisconnectHandler.ts": {
      calls: 1,
      reason:
        "Bounded stale-disconnect rediscovery reads the injected pool port and preserves captured incarnation checks.",
    },
    "src/devices/deviceDiscoveryContracts.ts": {
      calls: 2,
      reason:
        "Discovery API declarations extracted from deviceUtils; these define the producer contract below the pool.",
    },
    "src/devices/deviceUtils.ts": {
      calls: 7,
      reason:
        "PlatformDeviceManager implements the discovery API. The checked call is " +
        "the checked Android liveness guard before startDevice launches an AVD; it reads no pooled identity.",
    },
    "src/utils/android-cmdline-tools/EmulatorPortReservations.ts": {
      calls: 1,
      reason:
        "The pre-launch snapshot of attached emulator serials that console-port reservation reads (moved verbatim out of AndroidEmulatorClient); a local port-allocation decision, never joined to pooled identity.",
    },
    "src/utils/android-cmdline-tools/AndroidDeviceInventoryScanner.ts": {
      calls: 1,
      reason:
        "The booted-device inventory scan (moved verbatim out of AndroidEmulatorClient); an Android discovery producer that runs below the pool.",
    },
    "src/utils/android-cmdline-tools/AndroidEmulatorClient.ts": {
      calls: 8,
      reason:
        "Android emulator discovery producer; runs below the pool. Includes the startup-validation serial-listed probe (#13970), a local launch decision never joined to pooled identity.",
    },
    "src/utils/android-cmdline-tools/EmulatorLaunchCoordinator.ts": {
      calls: 2,
      reason:
        "The host-interface declaration plus adoptsExistingAvdLaunch (moved verbatim out of AndroidEmulatorClient): #6906's in-flight-launch guard — a local adopt-vs-spawn decision, never joined to pooled identity.",
    },
    "src/utils/android-cmdline-tools/EmulatorKiller.ts": {
      calls: 2,
      reason:
        "The host-interface declaration plus the kill-time serial rediscovery (moved verbatim out of AndroidEmulatorClient.discoverEmulatorsForKill); never joined to pooled identity.",
    },
    "src/utils/android-cmdline-tools/AdbClient.ts": {
      calls: 2,
      reason:
        "Public adb discovery declaration and delegate to AdbDeviceDiscovery; both run below the pool.",
    },
    "src/utils/android-cmdline-tools/AdbDeviceDiscovery.ts": {
      calls: 1,
      reason: "adb discovery producer moved verbatim from AdbClient; runs below the pool.",
    },
    "src/utils/android-cmdline-tools/interfaces/AdbExecutor.ts": {
      calls: 1,
      reason: "Interface declaration only.",
    },

    "src/daemon/sessionBroker/registry/platformLegacySlotDeviceStopper.ts": {
      calls: 1,
      reason:
        "Pre-migration retirement runs before pool discovery/session rehydration. It verifies native identity and shutdown directly and never reads pooled identity.",
    },

    // --- Routed through the funnel ------------------------------------------
    "src/daemon/deviceLossDiscovery.ts": {
      calls: 1,
      reason:
        "Disconnect monitor joins the observation to getAllDevices() by serial; reconciles first.",
    },
    "src/daemon/socketServer/inputDeviceGating.ts": {
      calls: 1,
      reason: "Input-target discovery reconciles first.",
    },
    "src/daemon/socketServer/ideDeviceRoutes.ts": {
      calls: 1,
      reason: "The ide/* device-addressed routes reconcile first, moved from socketServer.ts.",
    },
    "src/server/bootedDeviceResources.ts": {
      calls: 2,
      reason: "Publishes pool epoch/label per serial; reconciles before resolvePoolDeviceContext.",
    },
    "src/features/deviceLifecycle/boot/bootIdentity.ts": {
      calls: 2,
      reason: "Pre-boot serial validation and start lifecycle target reconcile their discoveries.",
    },
    "src/features/deviceLifecycle/teardown/shutdownDiscovery.ts": {
      calls: 1,
      reason: "Shutdown preflight routes its discovery through the funnel.",
    },
    "src/features/deviceLifecycle/teardown/teardownDiscovery.ts": {
      calls: 1,
      reason: "Teardown precondition routes its discovery through the funnel.",
    },
    "src/server/deviceToolsStartupLease.ts": {
      calls: 1,
      reason: "Startup offline-recovery classification uses fresh discovery and reconciles first.",
    },
    "src/server/deviceToolsListing.ts": {
      calls: 1,
      reason: "listDevices reconciles discovery before publishing pool-derived labels and epochs.",
    },
    "src/server/provisioning/provisioningBoot.ts": {
      calls: 2,
      reason:
        "provisionDevice exact-boot reconciles fresh Android or per-platform discovery into the " +
        "pool before deciding whether it resolves the requested identity or matching the pooled " +
        "entry it is about to hand out.",
    },
    "src/server/pipeline/readTarget.ts": {
      calls: 1,
      reason:
        "A control call naming an ADB transport address the pool has never folded (#11618) lists " +
        "fresh raw rows so the pool can fold the alias, then reconciles the folded listing " +
        "before the holder check reads pooled identity for it.",
    },
    "src/server/pipeline/deviceCallDispatch.ts": {
      calls: 1,
      reason:
        "The held-alias gate lists cached raw rows to get an unidentifiable transport's real row " +
        "and reconciles the listing before the shared rule reads pooled identity (#11596).",
    },
    "src/server/utilityTools.ts": {
      calls: 1,
      reason:
        "Fresh liveness gate before clearing the killDevice tombstone (#7586); the session-scoped " +
        "setActiveDevice path reads the same pooled device afterward, so it reconciles first.",
    },

    "src/daemon/streamDeviceResolver.ts": {
      calls: 2,
      reason:
        "Shared video/WebRTC discovery reconciles before selection, including bounded iOS retries.",
    },
    "src/daemon/deviceGestureRecordingSocketServer.ts": {
      calls: 1,
      reason:
        "Selects the recording target from the AVD-name-aware manager, reconciles before the " +
        "admission gate reads pooled identity, and readies the device only after the gate (#6923).",
    },

    // --- Consult no pooled identity -----------------------------------------
    "src/daemon/readiness/DeviceReadiness.ts": {
      calls: 1,
      reason:
        "Android readiness verifies the adb-level connection state below the pool and owns no pooled identity.",
    },
    "src/daemon/readiness/ReadinessSelection.ts": {
      calls: 3,
      reason:
        "Readiness discovery and selection moved from DeviceReadiness; tracks connection state " +
        "below the pool. resolveAndroidReadinessIdentity re-reads the AVD-name-aware listing so " +
        "provided/current readiness paths key the Window cache on the runtime (#7031).",
    },
    "src/daemon/readiness/watchReadiness.ts": {
      calls: 1,
      reason:
        "watchOS-only readiness (#14908) lists booted watches to resolve a call naming watchOS; " +
        "it never lists Android and never consults pooled identity.",
    },
    "src/devices/deviceBootRevalidation.ts": {
      calls: 1,
      reason:
        "Cache-bypassing iOS simulator re-check once its UDID lifecycle lease settles (#9902); " +
        "there is no pooled entry yet, and the caller reconciles its post-boot discovery.",
    },
    "src/devices/DeviceBootExecution.ts": {
      calls: 2,
      reason:
        "Boot-progress polling and fresh exact-name Android identity discovery moved from " +
        "deviceBootService; the caller reconciles its post-boot discovery before reading pooled identity.",
    },
    "src/utils/android-cmdline-tools/AvdSnapshotService.ts": {
      calls: 1,
      reason:
        "findLiveEmulatorSerial remains a full scan and reads no pool state; the pre-delete identity check now uses the bounded serial-targeted resolveAvdNameForSerial probe, a read-only confirmation rather than discovery.",
    },
    "src/features/observe/ios/IosCtrlProxyClientContracts.ts": {
      calls: 1,
      reason: "iOS only — simulator UDIDs are never reused, so there is no identity to reconcile.",
    },
    "src/daemon/idleDeviceReaper.ts": {
      calls: 1,
      reason:
        "iOS-only liveness sweep of idle pooled devices; the Android identity reconcile funnel does not apply.",
    },
    "src/doctor/checks/android.ts": {
      calls: 1,
      reason: "Diagnostics; reports what adb sees and reads no pool state.",
    },
    "src/doctor/checks/androidIntegrity.ts": {
      calls: 1,
      reason: "Diagnostics; lists booted devices to probe their signals and reads no pool state.",
    },
    "src/doctor/checks/automobile.ts": {
      calls: 2,
      reason: "Diagnostics; reports what adb sees and reads no pool state.",
    },

    // --- Per-device data resources -----------------------------------------
    // These are no longer exempt. "Publishes no pooled identity" confused not
    // PUBLISHING a pooled label with not ACTING on a pooled identity: each of
    // these resources resolved a serial and then read that runtime's
    // preferences, databases, DataStore contents, app files, locale or shared
    // storage. Eight near-identical `findBootedDevice` copies are now one
    // reconciling resolver, so the funnel obligation is discharged once
    // ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
    "src/server/resourceDeviceResolver.ts": {
      calls: 2,
      reason:
        "The legacy getBootedDevices path used when no AbortSignal is supplied and the " +
        "getBootedDevicesDetailed + signal path both converge on the same single " +
        "reconcileDiscoveryObservation call before returning, so the funnel obligation is " +
        "discharged exactly once regardless of which branch executes.",
    },
    "src/server/appResources.ts": {
      calls: 1,
      reason:
        "Registry sync only: registers/unregisters a per-device resource URI per booted serial " +
        "and reads no pool state. Its device-addressed reads go through resourceDeviceResolver.",
    },
  };

  function walk(dir: string, files: string[] = []): string[] {
    // withFileTypes, not a statSync per entry: one syscall for the whole
    // directory instead of one per file across ~1000 files in src/.
    for (const entry of guardDirectoryEntries(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, files);
      } else if (entry.name.endsWith(".ts")) {
        files.push(full);
      }
    }
    return files;
  }

  /**
   * Scanning every file in `src/` with the TypeScript scanner costs far more
   * than the 100ms per-test budget. Nearly every file names no discovery API at
   * all, so a raw-text prefilter decides that cheaply and only the handful that
   * survive pay for comment stripping. The result is memoized because all three
   * assertions below read the same inventory.
   */
  // The inventory and routed-file assertions overlap. Reuse each stripped
  // source within this suite's setup, independently of other files/run order.
  const strippedSources = new Map<string, string>();
  function sourceWithoutComments(file: string): string {
    const cached = strippedSources.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const source = blankComments(readGuardFile(join(ROOT, file)));
    strippedSources.set(file, source);
    return source;
  }

  let cachedCounts: Map<string, number> | undefined;
  let routedSources: { file: string; source: string }[] = [];
  let devicePoolSource = "";
  let discoveryReconcileSource = "";

  // The inventory is a fixture shared by all three assertions below, not work
  // any one of them owns; building it here keeps each test's own cost to the
  // comparison it actually makes.
  beforeAll(() => {
    discoveryCallCounts();
    const routed = [
      "src/daemon/deviceLossDiscovery.ts",
      "src/daemon/socketServerParts/SocketIdeRoutes.ts",
      "src/daemon/socketServer/ideDeviceRoutes.ts",
      "src/daemon/socketServer/inputDeviceGating.ts",
      "src/server/bootedDeviceResources.ts",
      "src/features/deviceLifecycle/boot/bootIdentity.ts",
      "src/features/deviceLifecycle/teardown/shutdownDiscovery.ts",
      "src/features/deviceLifecycle/teardown/teardownDiscovery.ts",
      "src/server/deviceToolsStartupLease.ts",
      "src/server/deviceToolsListing.ts",
      "src/server/provisioning/provisioningBoot.ts",
      "src/server/utilityTools.ts",
      "src/daemon/streamDeviceResolver.ts",
      "src/daemon/deviceGestureRecordingSocketServer.ts",
      "src/server/resourceDeviceResolver.ts",
    ];
    routedSources = routed.map((file) => ({ file, source: sourceWithoutComments(file) }));
    devicePoolSource = sourceWithoutComments("src/daemon/devicePool.ts");
    discoveryReconcileSource = sourceWithoutComments("src/daemon/discoveryReconcile.ts");
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  function discoveryCallCounts(): Map<string, number> {
    if (cachedCounts !== undefined) {
      return cachedCounts;
    }
    const counts = new Map<string, number>();
    for (const file of walk(SRC)) {
      const source = readGuardFile(file);
      if (!source.includes(DISCOVERY_PREFIX)) {
        continue;
      }
      const repoPath = relative(ROOT, file).split(sep).join("/");
      const stripped = blankComments(source);
      strippedSources.set(repoPath, stripped);
      const matches = stripped.match(DISCOVERY_CALL);
      if (matches && matches.length > 0) {
        counts.set(repoPath, matches.length);
      }
    }
    cachedCounts = counts;
    return counts;
  }

  test("every discovery call site in src/ is inventoried", () => {
    const counts = discoveryCallCounts();
    const unlisted = [...counts.keys()].filter((file) => ALLOWLIST[file] === undefined).sort();
    expect(unlisted).toEqual([]);
  });

  test("System UI ANR reboot uses its bounded image lookup without booted discovery", () => {
    const source = blankComments(readGuardFile(join(ROOT, "src/server/deviceToolsSystemUiAnr.ts")));
    expect(source, "src/server/deviceToolsSystemUiAnr.ts").not.toMatch(DISCOVERY_CALL);
  });

  test("no discovery call site was added to an inventoried file", () => {
    const counts = discoveryCallCounts();
    const drift = [...counts.entries()]
      .filter(([file, calls]) => ALLOWLIST[file] !== undefined && ALLOWLIST[file].calls !== calls)
      .map(([file, calls]) => `${file}: ${ALLOWLIST[file].calls} allowed, ${calls} found`)
      .sort();
    expect(drift).toEqual([]);
  });

  test("every inventoried file still exists and still discovers", () => {
    const counts = discoveryCallCounts();
    const stale = Object.keys(ALLOWLIST)
      .filter((file) => !counts.has(file))
      .sort();
    expect(stale).toEqual([]);
  });

  test("the funnel is reached from the routed files by its single name", () => {
    for (const { file, source } of routedSources) {
      expect(source, file).toMatch(/reconcileDiscoveryObservation\s*[?]?\.?\s*\(/);
    }
  });

  test("the funnel and its wrapper exist under their canonical names", () => {
    expect(devicePoolSource, "src/daemon/devicePool.ts").toMatch(/reconcileDiscoveryObservation\(/);
    expect(
      sourceWithoutComments("src/daemon/deviceRuntimeIdentity.ts"),
      "src/daemon/deviceRuntimeIdentity.ts",
    ).toMatch(/async reconcileDiscoveryObservation\(/);
    expect(discoveryReconcileSource, "src/daemon/discoveryReconcile.ts").toMatch(
      /export async function reconcileDiscoveryObservation\(/,
    );
  });

  test("the comment stripper does not count a mention in prose as a call site", () => {
    expect(
      blankComments("// see getBootedDevices() for the list\nconst x = 1;").match(DISCOVERY_CALL),
    ).toBeNull();
    expect(
      blankComments("/* getBootedDevicesDetailed(x) */\nconst y = 2;").match(DISCOVERY_CALL),
    ).toBeNull();
    expect(
      blankComments("await manager.getBootedDevices('android');").match(DISCOVERY_CALL),
    ).toHaveLength(1);
    // `toContain`, not a regex: the assertion is that the `//` inside a string
    // literal survived the stripper, and an unanchored URL regex is exactly the
    // shape CodeQL flags as a host-matching hazard.
    expect(blankComments('const url = "http://example.com";')).toContain('"http://example.com"');
  });

  test("the comment stripper handles comments after template substitutions", () => {
    const fixture = `const msg = \`failed: \${err}\`;
/**
 * See \`someOtherThing()\` for details. Do not call getBootedDevices()
 * directly from here.
 */
await manager.getBootedDevices('android');`;
    expect(blankComments(fixture).match(/\bgetBootedDevices\s*\(/g)).toHaveLength(1);
  });

  test("the comment stripper handles comments before closing tokens and at EOF", () => {
    const fixtures = [
      `function f() {
  a();
  // getBootedDevices()
}`,
      `foo(
  bar,
  // getBootedDevices()
);`,
      `const x = 1;
// getBootedDevices()`,
    ];

    for (const fixture of fixtures) {
      expect(blankComments(fixture).match(/\bgetBootedDevices\s*\(/g)).toBeNull();
      expect(
        blankComments(`${fixture}\nawait manager.getBootedDevices('android');`).match(
          /\bgetBootedDevices\s*\(/g,
        ),
      ).toHaveLength(1);
    }
  });
});
