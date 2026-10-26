import type { ProtoViewerDevice } from "../../../../src/features/prototype/protoViewer/protoViewerDevice";

/** One verdict line. `skipped` names a check this run could not automate; it never fails a run. */
export interface SmokeCheck {
  readonly name: string;
  readonly status: "pass" | "fail" | "skipped";
  readonly detail: string;
}

/** What an in-place install leaves behind: enough to tell "upgraded" from "uninstalled and reinstalled". */
export interface InstalledApp {
  /** versionCode (Android) or CFBundleVersion (iOS). */
  readonly version: string;
  /** Changes when the app's data is wiped: firstInstallTime (Android), data container path (iOS). */
  readonly dataIdentity: string;
}

/** Reads and taps the foreground screen. Absent on a platform without a UI driver here. */
export interface ScreenDriver {
  launchLibrary(): Promise<void>;
  visibleText(): Promise<readonly string[]>;
  tapText(text: string): Promise<boolean>;
}

export interface SmokeDriver {
  readonly platform: "android" | "ios";
  /** Installs over whatever is there; must never uninstall first. */
  install(artifact: string): Promise<void>;
  installedApp(): Promise<InstalledApp>;
  readonly viewer: ProtoViewerDevice;
  readonly screens?: ScreenDriver;
}

export interface SmokeBundle {
  readonly label: string;
  readonly bytes: Uint8Array;
}

export const IMPORT_TIMEOUT_MS = 20_000;
export const NETWORK_SETTING_TEXT = "Allow network for imported prototypes";
export const LICENSES_LINK_TEXT = "Open-source licenses";
export const LICENSES_ERROR_TEXT = "Unable to read the open-source licenses.";

const pass = (name: string, detail: string): SmokeCheck => ({ name, status: "pass", detail });
const fail = (name: string, detail: string): SmokeCheck => ({ name, status: "fail", detail });
const skipped = (name: string, detail: string): SmokeCheck => ({ name, status: "skipped", detail });

async function guarded(name: string, run: () => Promise<SmokeCheck>): Promise<SmokeCheck> {
  try {
    return await run();
  } catch (error) {
    return fail(name, error instanceof Error ? error.message : String(error));
  }
}

async function importBundle(
  driver: SmokeDriver,
  bundle: SmokeBundle,
): Promise<{ check: SmokeCheck; libraryId?: string }> {
  const name = `import ${bundle.label}`;
  try {
    const result = await driver.viewer.importBundle(bundle.bytes, bundle.label, IMPORT_TIMEOUT_MS);
    if (result.status !== "imported") {
      return { check: fail(name, `expected imported, got ${JSON.stringify(result)}`) };
    }
    return { check: pass(name, `libraryId ${result.libraryId}`), libraryId: result.libraryId };
  } catch (error) {
    return { check: fail(name, error instanceof Error ? error.message : String(error)) };
  }
}

async function openEntry(
  driver: SmokeDriver,
  name: string,
  libraryId: string,
  label: string,
): Promise<SmokeCheck> {
  return guarded(name, async () => {
    const result = await driver.viewer.open(libraryId, IMPORT_TIMEOUT_MS);
    if (result.status !== "opened") {
      return fail(name, `expected opened, got ${JSON.stringify(result)}`);
    }
    if (result.libraryId !== libraryId || result.label !== label) {
      return fail(
        name,
        `opened ${result.libraryId} "${result.label}", wanted ${libraryId} "${label}"`,
      );
    }
    return pass(name, `opened ${libraryId}`);
  });
}

/** Release N+1 installed over N keeps the saved library (#15387). Settings are not automated. */
export async function runUpgradeInPlace(
  driver: SmokeDriver,
  artifacts: { previous: string; candidate: string },
  bundle: SmokeBundle,
): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = [];
  const installPrevious = await guarded("install previous release", async () => {
    await driver.install(artifacts.previous);
    return pass("install previous release", artifacts.previous);
  });
  checks.push(installPrevious);
  if (installPrevious.status === "fail") return checks;

  const before = await driver.installedApp();
  const imported = await importBundle(driver, bundle);
  checks.push(imported.check);
  if (imported.libraryId === undefined) return checks;

  const installCandidate = await guarded("install candidate over previous", async () => {
    await driver.install(artifacts.candidate);
    return pass("install candidate over previous", artifacts.candidate);
  });
  checks.push(installCandidate);
  if (installCandidate.status === "fail") return checks;

  checks.push(
    await guarded("upgraded in place", async () => {
      const after = await driver.installedApp();
      if (after.version === before.version) {
        return fail(
          "upgraded in place",
          `version stayed ${after.version}; the candidate must be newer`,
        );
      }
      if (after.dataIdentity !== before.dataIdentity) {
        return fail(
          "upgraded in place",
          `app data identity changed (${before.dataIdentity} -> ${after.dataIdentity}): the app was reinstalled, not upgraded`,
        );
      }
      return pass("upgraded in place", `${before.version} -> ${after.version}, data identity kept`);
    }),
  );
  checks.push(
    await openEntry(driver, "saved library entry survives", imported.libraryId, bundle.label),
  );
  checks.push(
    skipped(
      "settings survive",
      "the network switch needs a runtime permission grant; check it by hand on the device",
    ),
  );
  return checks;
}

async function screenChecks(screens: ScreenDriver): Promise<SmokeCheck[]> {
  const settings = await guarded("settings screen", async () => {
    await screens.launchLibrary();
    const text = await screens.visibleText();
    return text.includes(NETWORK_SETTING_TEXT)
      ? pass("settings screen", `"${NETWORK_SETTING_TEXT}" is shown`)
      : fail("settings screen", `"${NETWORK_SETTING_TEXT}" not found among ${text.length} texts`);
  });
  const licenses = await guarded("licenses screen", async () => {
    if (!(await screens.tapText(LICENSES_LINK_TEXT))) {
      return fail("licenses screen", `"${LICENSES_LINK_TEXT}" not found to tap`);
    }
    const text = await screens.visibleText();
    if (text.includes(LICENSES_ERROR_TEXT)) {
      return fail("licenses screen", "the screen reports it cannot read the licenses");
    }
    return text.some((line) => /apache/i.test(line))
      ? pass("licenses screen", "license text is listed")
      : fail("licenses screen", `no license text among ${text.length} texts`);
  });
  return [settings, licenses];
}

/** The minified release opens a bundled and an imported prototype, and shows both screens. */
export async function runMinifiedSmoke(
  driver: SmokeDriver,
  artifact: string,
  bundles: { bundled: SmokeBundle; imported: SmokeBundle },
): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = [];
  const installed = await guarded("install release artifact", async () => {
    await driver.install(artifact);
    return pass("install release artifact", artifact);
  });
  checks.push(installed);
  if (installed.status === "fail") return checks;

  for (const bundle of [bundles.bundled, bundles.imported]) {
    const imported = await importBundle(driver, bundle);
    checks.push(imported.check);
    if (imported.libraryId !== undefined) {
      checks.push(
        await openEntry(driver, `open ${bundle.label}`, imported.libraryId, bundle.label),
      );
    }
  }
  if (driver.screens === undefined) {
    checks.push(
      skipped(
        "settings screen",
        `no ${driver.platform} UI driver in this script; check Settings and Open-source licenses by hand`,
      ),
      skipped("licenses screen", "same"),
    );
  } else {
    checks.push(...(await screenChecks(driver.screens)));
  }
  return checks;
}

export function summarize(checks: readonly SmokeCheck[]): { text: string; failed: boolean } {
  const lines = checks.map(
    (check) => `${check.status.toUpperCase().padEnd(7)} ${check.name}: ${check.detail}`,
  );
  const failed = checks.some((check) => check.status === "fail");
  return { text: lines.join("\n"), failed };
}
