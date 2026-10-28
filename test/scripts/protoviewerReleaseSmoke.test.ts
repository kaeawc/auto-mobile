import { beforeAll, describe, expect, test } from "bun:test";
import { readPrototypeBundle } from "../../src/features/prototype/prototypeBundle";
import type { ProtoViewerDevice } from "../../src/features/prototype/protoViewer/protoViewerDevice";
import type { ProtoViewerResult } from "../../src/features/prototype/protoViewer/protoViewerContract";
import {
  boundsCenter,
  collectUiNodes,
  parseInstalledApp,
} from "../../scripts/release/lib/protoviewer-smoke/androidDriver";
import { smokeBundles } from "../../scripts/release/lib/protoviewer-smoke/bundles";
import { createIosDriver } from "../../scripts/release/lib/protoviewer-smoke/iosDriver";
import type { ToolRunner } from "../../scripts/release/lib/artifact-policy/toolRunner";
import { PROTOVIEWER_PACKAGE } from "../../src/features/prototype/protoViewer/protoViewerContract";
import {
  LICENSES_ERROR_TEXT,
  LICENSES_LINK_TEXT,
  NETWORK_SETTING_TEXT,
  runMinifiedSmoke,
  runUpgradeInPlace,
  summarize,
  type InstalledApp,
  type ScreenDriver,
  type SmokeDriver,
} from "../../scripts/release/lib/protoviewer-smoke/flows";

const LIBRARY_ID = "11111111-1111-4111-8111-111111111111";

class FakeViewer implements ProtoViewerDevice {
  readonly library = new Map<string, string>();
  wipeOnInstall = false;
  async installed(): Promise<boolean> {
    return true;
  }
  async importBundle(_bytes: Uint8Array, label: string | undefined): Promise<ProtoViewerResult> {
    const libraryId = `${LIBRARY_ID.slice(0, -2)}${String(this.library.size).padStart(2, "0")}`;
    this.library.set(libraryId, label ?? "");
    return { status: "imported", request: "r", libraryId, label: label ?? "" };
  }
  async open(libraryId: string): Promise<ProtoViewerResult> {
    const label = this.library.get(libraryId);
    return label === undefined
      ? { status: "not_found", request: "r" }
      : { status: "opened", request: "r", libraryId, label };
  }
}

class FakeDriver implements SmokeDriver {
  readonly platform = "android" as const;
  readonly viewer = new FakeViewer();
  readonly installs: string[] = [];
  app: InstalledApp = { version: "0", dataIdentity: "t0" };
  constructor(
    private readonly versions: Record<string, string>,
    readonly screens?: ScreenDriver,
    private readonly reinstall = false,
  ) {}
  async install(artifact: string): Promise<void> {
    this.installs.push(artifact);
    const wiped = this.reinstall && this.installs.length > 1;
    if (wiped) {
      this.viewer.library.clear();
    }
    this.app = {
      version: this.versions[artifact] ?? "?",
      dataIdentity: wiped ? `t${this.installs.length}` : this.app.dataIdentity,
    };
  }
  async installedApp(): Promise<InstalledApp> {
    return this.app;
  }
}

class FakeScreens implements ScreenDriver {
  private screen: readonly string[] = [];
  constructor(
    private readonly library: readonly string[],
    private readonly licenses: readonly string[],
  ) {}
  async launchLibrary(): Promise<void> {
    this.screen = this.library;
  }
  async visibleText(): Promise<readonly string[]> {
    return this.screen;
  }
  async tapText(text: string): Promise<boolean> {
    if (!this.screen.includes(text)) {
      return false;
    }
    this.screen = this.licenses;
    return true;
  }
}

const bundle = { label: "kept", bytes: new Uint8Array([1]) };
const artifacts = { previous: "n.apk", candidate: "n1.apk" };
const statuses = (checks: { name: string; status: string }[]) =>
  Object.fromEntries(checks.map((check) => [check.name, check.status]));

class FakeIosRunner implements ToolRunner {
  readonly calls: { command: string; args: readonly string[] }[] = [];
  terminationError?: Error;
  private version = 0;
  async run(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ command, args });
    if (args[1] === "install") {
      this.version++;
    }
    if (args[1] === "terminate" && this.terminationError) {
      throw this.terminationError;
    }
    return { stdout: command === "plutil" ? String(this.version) : "/data", stderr: "" };
  }
}

describe("iOS smoke launch state", () => {
  test("terminates only ProtoViewer on the supplied udid", async () => {
    const runner = new FakeIosRunner();
    const driver = createIosDriver("fake-udid", runner);
    await driver.prepareForUrlOpen?.();
    expect(runner.calls).toEqual([
      { command: "xcrun", args: ["simctl", "terminate", "fake-udid", PROTOVIEWER_PACKAGE] },
    ]);
  });

  test("already not running is a successful start state", async () => {
    const runner = new FakeIosRunner();
    runner.terminationError = Object.assign(new Error("Application is not running"), { code: 3 });
    await createIosDriver("fake-udid", runner).prepareForUrlOpen?.();
    expect(runner.calls).toHaveLength(1);
  });

  test("unexpected terminate errors propagate", async () => {
    const runner = new FakeIosRunner();
    runner.terminationError = Object.assign(new Error("Simulator unavailable"), { code: 149 });
    const driver = createIosDriver("fake-udid", runner);
    await expect(driver.prepareForUrlOpen?.()).rejects.toThrow("Simulator unavailable");
  });

  for (const mode of ["smoke", "upgrade"] as const) {
    test(`${mode} terminates before every import and open, using only fakes`, async () => {
      const runner = new FakeIosRunner();
      const driver = createIosDriver("fake-udid", runner);
      const viewer = new FakeViewer();
      const events: string[] = [];
      // Substitute the viewer as well: no real simctl, files, timers or simulator are used.
      const fake: SmokeDriver = {
        ...driver,
        viewer: {
          installed: () => viewer.installed(),
          async importBundle(bytes, label) {
            expect(runner.calls.at(-1)?.args[1]).toBe("terminate");
            events.push("import");
            runner.calls.length = 0;
            return viewer.importBundle(bytes, label);
          },
          async open(libraryId) {
            expect(runner.calls.at(-1)?.args[1]).toBe("terminate");
            events.push("open");
            runner.calls.length = 0;
            return viewer.open(libraryId);
          },
        },
      };
      const checks =
        mode === "smoke"
          ? await runMinifiedSmoke(fake, "candidate.app", { bundled: bundle, imported: bundle })
          : await runUpgradeInPlace(
              fake,
              { previous: "old.app", candidate: "candidate.app" },
              bundle,
            );
      expect(events).toEqual(
        mode === "smoke" ? ["import", "open", "import", "open"] : ["import", "open"],
      );
      expect(checks.find((check) => check.name.startsWith("import"))?.status).toBe("pass");
      expect(summarize(checks).failed).toBe(false);
    });
  }

  test("a failed launch-state step fails the check without importing", async () => {
    const runner = new FakeIosRunner();
    runner.terminationError = new Error("terminate failed");
    const viewer = new FakeViewer();
    const driver: SmokeDriver = { ...createIosDriver("fake-udid", runner), viewer };
    const checks = await runMinifiedSmoke(driver, "candidate.app", {
      bundled: bundle,
      imported: bundle,
    });
    expect(viewer.library.size).toBe(0);
    expect(statuses(checks)["import kept"]).toBe("fail");
    expect(summarize(checks).text).toContain("terminate failed");
  });
});

describe("ProtoViewer upgrade in place", () => {
  test("keeps the saved entry, installs over without uninstalling and skips settings", async () => {
    const driver = new FakeDriver({ "n.apk": "1", "n1.apk": "2" });
    const checks = await runUpgradeInPlace(driver, artifacts, bundle);
    expect(driver.installs).toEqual(["n.apk", "n1.apk"]);
    expect(statuses(checks)).toEqual({
      "install previous release": "pass",
      "import kept": "pass",
      "install candidate over previous": "pass",
      "upgraded in place": "pass",
      "saved library entry survives": "pass",
      "settings survive": "skipped",
    });
    expect(summarize(checks).failed).toBe(false);
  });

  test("a reinstall that wipes data is reported as not an upgrade", async () => {
    const driver = new FakeDriver({ "n.apk": "1", "n1.apk": "2" }, undefined, true);
    const checks = await runUpgradeInPlace(driver, artifacts, bundle);
    expect(statuses(checks)["upgraded in place"]).toBe("fail");
    expect(statuses(checks)["saved library entry survives"]).toBe("fail");
    expect(summarize(checks).failed).toBe(true);
  });

  test("a candidate that is not newer fails", async () => {
    const driver = new FakeDriver({ "n.apk": "2", "n1.apk": "2" });
    const checks = await runUpgradeInPlace(driver, artifacts, bundle);
    expect(statuses(checks)["upgraded in place"]).toBe("fail");
  });

  test("a failed import stops before the candidate is installed", async () => {
    const driver = new FakeDriver({ "n.apk": "1", "n1.apk": "2" });
    driver.viewer.importBundle = async () => ({
      status: "rejected",
      request: "r",
      path: "$",
      reason: "bad",
    });
    const checks = await runUpgradeInPlace(driver, artifacts, bundle);
    expect(driver.installs).toEqual(["n.apk"]);
    expect(statuses(checks)["import kept"]).toBe("fail");
  });
});

describe("ProtoViewer minified smoke", () => {
  const bundles = { bundled: { ...bundle, label: "a" }, imported: { ...bundle, label: "b" } };
  const library = ["ProtoViewer", NETWORK_SETTING_TEXT, LICENSES_LINK_TEXT];

  test("opens both prototypes and shows the settings and licenses screens", async () => {
    const driver = new FakeDriver({}, new FakeScreens(library, ["Apache License 2.0"]));
    const checks = await runMinifiedSmoke(driver, "min.apk", bundles);
    expect(Object.values(statuses(checks)).every((status) => status === "pass")).toBe(true);
    expect(checks.map((check) => check.name)).toContain("open b");
  });

  test("a licenses screen that cannot read its list fails", async () => {
    const driver = new FakeDriver({}, new FakeScreens(library, [LICENSES_ERROR_TEXT]));
    const checks = await runMinifiedSmoke(driver, "min.apk", bundles);
    expect(statuses(checks)["licenses screen"]).toBe("fail");
  });

  test("a platform without a UI driver skips the screens instead of passing them", async () => {
    const checks = await runMinifiedSmoke(new FakeDriver({}), "min.apk", bundles);
    expect(statuses(checks)["settings screen"]).toBe("skipped");
    expect(summarize(checks).failed).toBe(false);
  });
});

describe("Android driver parsing", () => {
  test("reads text and content descriptions from a uiautomator tree", () => {
    const tree = {
      hierarchy: {
        node: [
          {
            $: { text: "", "content-desc": "", bounds: "[0,0][10,10]" },
            node: [{ $: { text: "Open-source licenses", bounds: "[10,20][30,60]" } }],
          },
        ],
      },
    };
    expect(collectUiNodes(tree)).toEqual([
      { text: "Open-source licenses", bounds: "[10,20][30,60]" },
    ]);
    expect(boundsCenter("[10,20][30,60]")).toEqual({ x: 20, y: 40 });
    expect(boundsCenter("nonsense")).toBeUndefined();
  });

  test("takes versionCode and firstInstallTime from dumpsys and rejects an absent package", () => {
    const dump = "    versionCode=7 minSdk=26\n    firstInstallTime=2026-10-26 10:00:00\n";
    expect(parseInstalledApp(dump)).toEqual({ version: "7", dataIdentity: "2026-10-26 10:00:00" });
    expect(() => parseInstalledApp("Unable to find package")).toThrow("not installed");
  });
});

describe("smoke bundles", () => {
  // Building a bundle is real zip and validation work, so it stays out of the per-test budget.
  let built: ReturnType<typeof smokeBundles>;
  beforeAll(() => {
    built = smokeBundles();
  });

  test("both build into readable bundles with distinct labels", () => {
    expect(built.bundled.label).not.toBe(built.imported.label);
    for (const entry of [built.bundled, built.imported]) {
      expect(readPrototypeBundle(entry.bytes).ok).toBe(true);
    }
  });
});
