import { describe, expect, test } from "bun:test";
import path from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  NETWORK_FILTER_APPROVAL_STEPS,
  NETWORK_FILTER_APP_NAME,
  NETWORK_FILTER_APP_PATH_ENV,
  NETWORK_FILTER_RESTART_STEPS,
  NETWORK_FILTER_TEAM_ID_ENV,
} from "../../../src/features/networkFilter/networkFilterApp";
import type { NetworkFilterAppCandidate } from "../../../src/features/networkFilter/NetworkFilterAppProvider";
import {
  NETWORK_FILTER_RECEIPT_FILENAME,
  NetworkFilterInstaller,
  NetworkFilterStatusInspector,
} from "../../../src/features/networkFilter/NetworkFilterInstaller";
import type { NetworkFilterCommandOutcome } from "../../../src/features/networkFilter/networkFilterHost";
import {
  FakeCodeSignVerifier,
  FakeFileInstaller,
  FakeNetworkFilterCommandRunner,
  FakeNetworkFilterFileSystem,
  VALID_TEAM,
  signedInspection,
} from "../../fakes/FakeNetworkFilterHost";
import { FakeTimer } from "../../fakes/FakeTimer";

const INSTALL_DIR = path.join(path.sep, "Applications");
const DESTINATION = path.join(INSTALL_DIR, NETWORK_FILTER_APP_NAME);
const CACHE = path.join(path.sep, "cache", "network-filter");
const CANDIDATE: NetworkFilterAppCandidate = {
  appPath: path.join(CACHE, "app", NETWORK_FILTER_APP_NAME),
  source: "release",
  version: "0.0.90",
  sha256: "b".repeat(64),
};

function controllerJson(
  state: string,
  detail: string,
  exitCode = 0,
): Partial<NetworkFilterCommandOutcome> {
  return { exitCode, stdout: `${JSON.stringify({ version: 1, state, detail })}\n` };
}

function setup(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    ensure?: () => Promise<NetworkFilterAppCandidate>;
    activate?: Partial<NetworkFilterCommandOutcome>;
  } = {},
) {
  const verifier = new FakeCodeSignVerifier();
  const fileInstaller = new FakeFileInstaller();
  const runner = new FakeNetworkFilterCommandRunner();
  runner.handler = () => options.activate ?? controllerJson("ready", "Allow-only provider replied");
  const fileSystem = new FakeNetworkFilterFileSystem();
  const installer = new NetworkFilterInstaller({
    appSource: { ensure: options.ensure ?? (async () => CANDIDATE), cacheDirectory: CACHE },
    verifier,
    fileInstaller,
    commandRunner: runner,
    fileSystem,
    timer: new FakeTimer(),
    env: options.env ?? {},
    platform: options.platform ?? "darwin",
    installDir: INSTALL_DIR,
  });
  return { installer, verifier, fileInstaller, runner, fileSystem };
}

describe("NetworkFilterInstaller", () => {
  test("installs to /Applications, activates and stops at approval_required with the steps", async () => {
    const { installer, fileInstaller, runner, fileSystem } = setup({
      activate: controllerJson(
        "approval_required",
        "Approve AutoMobile Network Identity Probe in System Settings, then run activate again.",
      ),
    });

    const result = await installer.install();

    expect(result).toMatchObject({
      state: "approval_required",
      action: "installed",
      installedPath: DESTINATION,
      source: "release",
      version: "0.0.90",
      nextSteps: NETWORK_FILTER_APPROVAL_STEPS,
    });
    expect(fileInstaller.installs).toEqual([
      { source: CANDIDATE.appPath, destination: DESTINATION, replace: false },
    ]);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.file.endsWith(path.join("MacOS", "network-filter-controller"))).toBe(
      true,
    );
    expect(runner.calls[0]?.file.startsWith(DESTINATION)).toBe(true);
    expect(runner.calls[0]?.args).toEqual(["activate"]);
    const receipt = JSON.parse(
      (await fileSystem.readText(path.join(CACHE, NETWORK_FILTER_RECEIPT_FILENAME))) ?? "{}",
    );
    expect(receipt).toMatchObject({
      version: "0.0.90",
      source: "release",
      cdhash: "cdhash-candidate",
    });
  });

  test("reports ready after approval when re-run against an identical installed copy", async () => {
    const { installer, fileInstaller } = setup();
    fileInstaller.existing.add(DESTINATION);

    const result = await installer.install();

    expect(result).toMatchObject({ state: "ready", action: "unchanged" });
    expect(fileInstaller.installs).toHaveLength(0);
  });

  test("maps a pending restart to restart_required with restart steps", async () => {
    const { installer } = setup({
      activate: controllerJson(
        "approval_required",
        "Extension installation will finish after restarting macOS.",
      ),
    });

    const result = await installer.install();

    expect(result.state).toBe("restart_required");
    expect(result.nextSteps).toBe(NETWORK_FILTER_RESTART_STEPS);
  });

  test("a checksum mismatch fails closed and leaves /Applications untouched", async () => {
    const { installer, fileInstaller, runner, verifier } = setup({
      ensure: async () => {
        throw new ActionableError("Network Extension app checksum verification failed.");
      },
    });

    const result = await installer.install();

    expect(result).toMatchObject({ state: "failed", action: "none" });
    expect(result.detail).toContain("checksum verification failed");
    expect(fileInstaller.installs).toHaveLength(0);
    expect(verifier.inspected).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });

  test("a team that differs from the pinned team fails closed", async () => {
    const { installer, fileInstaller, runner } = setup({
      env: { [NETWORK_FILTER_TEAM_ID_ENV]: "ZZZZZ99999" },
    });

    const result = await installer.install();

    expect(result.state).toBe("failed");
    expect(result.detail).toContain(
      `signing team ${VALID_TEAM} does not match the pinned team ZZZZZ99999`,
    );
    expect(fileInstaller.installs).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });

  test("an app and provider signed by different teams fail closed", async () => {
    const { installer, verifier, fileInstaller } = setup();
    verifier.fallback = signedInspection({ providerTeam: "OTHER12345" });

    const result = await installer.install();

    expect(result.detail).toContain("provider team OTHER12345 differs from app team");
    expect(fileInstaller.installs).toHaveLength(0);
  });

  test("an unsigned or tampered app fails closed", async () => {
    const { installer, verifier, fileInstaller } = setup();
    verifier.fallback = signedInspection({ verified: false, team: null });

    const result = await installer.install();

    expect(result.state).toBe("failed");
    expect(result.detail).toContain("codesign --verify --deep --strict failed");
    expect(result.detail).toContain("not signed by a Developer ID team");
    expect(fileInstaller.installs).toHaveLength(0);
  });

  test("a wrong bundle identifier fails closed", async () => {
    const { installer, verifier } = setup();
    verifier.fallback = signedInspection({ appIdentifier: "com.example.other" });

    const result = await installer.install();

    expect(result.detail).toContain("app identifier is com.example.other");
  });

  test("does not overwrite a differing installed copy without --upgrade", async () => {
    const { installer, verifier, fileInstaller, runner } = setup();
    fileInstaller.existing.add(DESTINATION);
    verifier.byPath.set(DESTINATION, signedInspection({ cdhash: "cdhash-older" }));

    const result = await installer.install();

    expect(result).toMatchObject({ state: "failed", action: "none" });
    expect(result.detail).toContain("different version or signature");
    expect(result.nextSteps).toContain("--upgrade");
    expect(fileInstaller.installs).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });

  test("replaces a differing installed copy with --upgrade", async () => {
    const { installer, verifier, fileInstaller } = setup();
    fileInstaller.existing.add(DESTINATION);
    verifier.byPath.set(DESTINATION, signedInspection({ cdhash: "cdhash-older" }));

    const result = await installer.install({ upgrade: true });

    expect(result).toMatchObject({ state: "ready", action: "upgraded" });
    expect(fileInstaller.installs).toEqual([
      { source: CANDIDATE.appPath, destination: DESTINATION, replace: true },
    ]);
  });

  test("an override app is installed and recorded as a local override", async () => {
    const overridePath = path.join(path.sep, "work", NETWORK_FILTER_APP_NAME);
    const { installer, fileInstaller, fileSystem } = setup({
      env: { [NETWORK_FILTER_APP_PATH_ENV]: overridePath },
      ensure: async () => ({
        appPath: overridePath,
        source: "override",
        version: "local-override",
        sha256: null,
      }),
    });

    const result = await installer.install();

    expect(result).toMatchObject({ state: "ready", source: "override", version: "local-override" });
    expect(fileInstaller.installs[0]?.source).toBe(overridePath);
    const receipt = await fileSystem.readText(path.join(CACHE, NETWORK_FILTER_RECEIPT_FILENAME));
    expect(receipt).toContain("local-override");
  });

  test("a copy failure is reported as failed", async () => {
    const { installer, fileInstaller, runner } = setup();
    fileInstaller.failWith = new ActionableError(
      "Installing into /Applications needs an administrator account.",
    );

    const result = await installer.install();

    expect(result.state).toBe("failed");
    expect(result.detail).toContain("administrator");
    expect(runner.calls).toHaveLength(0);
  });

  test("reports unavailable on hosts other than macOS without preparing anything", async () => {
    let ensured = false;
    const { installer } = setup({
      platform: "linux",
      ensure: async () => {
        ensured = true;
        return CANDIDATE;
      },
    });

    expect((await installer.install()).state).toBe("unavailable");
    expect(ensured).toBe(false);
  });
});

describe("NetworkFilterStatusInspector", () => {
  function inspector(fileSystem: FakeNetworkFilterFileSystem, env: NodeJS.ProcessEnv = {}) {
    const runner = new FakeNetworkFilterCommandRunner();
    runner.handler = () => controllerJson("ready", "Allow-only provider replied");
    return {
      runner,
      inspector: new NetworkFilterStatusInspector({
        fileSystem,
        commandRunner: runner,
        cacheDir: CACHE,
        env,
        installDir: INSTALL_DIR,
      }),
    };
  }

  test("reports not installed without running the controller", async () => {
    const { inspector: subject, runner } = inspector(new FakeNetworkFilterFileSystem());

    const status = await subject.inspect();

    expect(status).toMatchObject({ installed: false, report: null });
    expect(runner.calls).toHaveLength(0);
  });

  test("reads the receipt version and the controller's read-only status", async () => {
    const fileSystem = new FakeNetworkFilterFileSystem();
    fileSystem.addApp(DESTINATION);
    fileSystem.addFile(
      path.join(CACHE, NETWORK_FILTER_RECEIPT_FILENAME),
      JSON.stringify({ version: "0.0.90" }),
    );
    const { inspector: subject, runner } = inspector(fileSystem, { AUTOMOBILE_VERSION: "0.0.91" });

    const status = await subject.inspect({ timeoutMs: 500 });

    expect(status).toMatchObject({
      installed: true,
      installedVersion: "0.0.90",
      expectedVersion: "0.0.91",
      report: { state: "ready" },
    });
    expect(runner.calls[0]?.args).toEqual(["status"]);
    expect(runner.calls[0]?.timeoutMs).toBe(500);
  });
});
