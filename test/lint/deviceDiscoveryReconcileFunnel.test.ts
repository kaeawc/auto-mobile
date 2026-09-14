import ts from "typescript";
import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

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
    "src/daemon/devicePool.ts": {
      calls: 8,
      reason: "The pool IS the funnel: refresh sweep and assignment-time liveness check.",
    },
    "src/utils/deviceUtils.ts": {
      calls: 8,
      reason: "PlatformDeviceManager — declares and implements the discovery API.",
    },
    "src/utils/android-cmdline-tools/AndroidEmulatorClient.ts": {
      calls: 9,
      reason:
        "Android emulator discovery producer; runs below the pool. The 9th call (adoptsExistingAvdLaunch, line 1678) is #6906's in-flight-launch guard — a local adopt-vs-spawn decision, never joined to pooled identity.",
    },
    "src/utils/android-cmdline-tools/AdbClient.ts": {
      calls: 2,
      reason: "adb discovery producer; runs below the pool.",
    },
    "src/utils/android-cmdline-tools/interfaces/AdbExecutor.ts": {
      calls: 1,
      reason: "Interface declaration only.",
    },

    // --- Routed through the funnel ------------------------------------------
    "src/daemon/daemon.ts": {
      calls: 1,
      reason:
        "Disconnect monitor joins the observation to getAllDevices() by serial; reconciles first.",
    },
    "src/daemon/socketServer.ts": {
      calls: 3,
      reason:
        "Input-target discovery and the ide/* device-addressed routes; each reconciles first.",
    },
    "src/server/bootedDeviceResources.ts": {
      calls: 2,
      reason: "Publishes pool epoch/label per serial; reconciles before resolvePoolDeviceContext.",
    },
    "src/server/deviceTools.ts": {
      calls: 6,
      reason:
        "Shutdown preflight, teardown precondition, pre-boot serial validation, start lifecycle " +
        "target, listDevices and provisionDevice exact-boot; each reconciles first.",
    },

    "src/daemon/webrtcStreamSocketServer.ts": {
      calls: 1,
      reason:
        "Picks a stream candidate by platform from an injected manager, then hands it to an " +
        "admission gate that reads pooled identity; reconciles first.",
    },
    "src/daemon/videoStreamSocketServer.ts": {
      calls: 1,
      reason:
        "Picks a stream candidate across both platforms from the AVD-name-aware manager, then " +
        "reconciles before the admission gate reads pooled identity.",
    },

    // --- Consult no pooled identity -----------------------------------------
    "src/utils/DeviceSessionManager.ts": {
      calls: 3,
      reason: "Tracks adb-level connection state; owns no pooled identity and runs below the pool.",
    },
    "src/utils/deviceBootService.ts": {
      calls: 3,
      reason:
        "Boot-progress polling for a device being created; there is no pooled entry yet, and the " +
        "caller (deviceTools) reconciles its own post-boot discovery.",
    },
    "src/utils/android-cmdline-tools/AvdSnapshotService.ts": {
      calls: 2,
      reason:
        "Snapshot reclaim checks whether an AVD is live in findLiveEmulatorSerial and re-verifies the serial's AVD identity before each console deletion attempt; both read no pool state.",
    },
    "src/features/observe/ios/IOSCtrlProxyClient.ts": {
      calls: 1,
      reason: "iOS only — simulator UDIDs are never reused, so there is no identity to reconcile.",
    },
    "src/doctor/checks/android.ts": {
      calls: 1,
      reason: "Diagnostics; reports what adb sees and reads no pool state.",
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

  /**
   * Strip comments before matching: a call named in prose ("see
   * `getBootedDevices`") is not a call site, and this file's own guard would
   * otherwise churn every time a doc comment mentions the API. The TypeScript
   * scanner is used rather than a regex so a `//` inside a string literal
   * survives.
   */
  /**
   * Replace every comment's characters with spaces, in place, so a mention in
   * prose ("see `getBootedDevices`") is not counted as a call site while every
   * OFFSET in the file stays exactly where it was. Preserving offsets is what
   * lets the real parser run on the untouched source and still read
   * comment-free body text: handing the parser a shortened, scanner-rewritten
   * copy silently dropped declarations, because a bare scanner cannot tell a
   * regex literal from division.
   */
  function blankComments(source: string): string {
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      /* skipTrivia */ false,
      ts.LanguageVariant.Standard,
      source,
    );
    const out = source.split("");
    let offset = 0;
    for (
      let token = scanner.scan();
      token !== ts.SyntaxKind.EndOfFileToken;
      token = scanner.scan()
    ) {
      const text = scanner.getTokenText();
      if (
        token === ts.SyntaxKind.SingleLineCommentTrivia ||
        token === ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        for (let index = offset; index < offset + text.length; index += 1) {
          // Newlines survive so line structure — and any assertion that reads
          // it — is unchanged.
          if (out[index] !== "\n" && out[index] !== "\r") {
            out[index] = " ";
          }
        }
      }
      offset += text.length;
    }
    return out.join("");
  }

  function walk(dir: string, files: string[] = []): string[] {
    // withFileTypes, not a statSync per entry: one syscall for the whole
    // directory instead of one per file across ~1000 files in src/.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
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
  let cachedCounts: Map<string, number> | undefined;

  // The inventory is a fixture shared by all three assertions below, not work
  // any one of them owns; building it here keeps each test's own cost to the
  // comparison it actually makes.
  beforeAll(() => {
    discoveryCallCounts();
  });

  function discoveryCallCounts(): Map<string, number> {
    if (cachedCounts !== undefined) {
      return cachedCounts;
    }
    const counts = new Map<string, number>();
    for (const file of walk(SRC)) {
      if (!readFileSync(file).includes(DISCOVERY_PREFIX)) {
        continue;
      }
      const matches = blankComments(readFileSync(file, "utf8")).match(DISCOVERY_CALL);
      if (matches && matches.length > 0) {
        counts.set(relative(ROOT, file).split(sep).join("/"), matches.length);
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
    const routed = [
      "src/daemon/daemon.ts",
      "src/daemon/socketServer.ts",
      "src/server/bootedDeviceResources.ts",
      "src/server/deviceTools.ts",
      "src/daemon/webrtcStreamSocketServer.ts",
      "src/daemon/videoStreamSocketServer.ts",
      "src/server/resourceDeviceResolver.ts",
    ];
    for (const file of routed) {
      const source = blankComments(readFileSync(join(ROOT, file), "utf8"));
      expect(source).toMatch(/reconcileDiscoveryObservation\s*[?]?\.?\s*\(/);
    }
  });

  test("the funnel and its wrapper exist under their canonical names", () => {
    expect(blankComments(readFileSync(join(ROOT, "src/daemon/devicePool.ts"), "utf8"))).toMatch(
      /async reconcileDiscoveryObservation\(/,
    );
    expect(
      blankComments(readFileSync(join(ROOT, "src/daemon/discoveryReconcile.ts"), "utf8")),
    ).toMatch(/export async function reconcileDiscoveryObservation\(/);
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
});
