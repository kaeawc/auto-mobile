import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  NETWORK_FILTER_APPROVAL_STEPS,
  NETWORK_FILTER_APP_NAME,
  providerPath,
} from "../../../src/features/networkFilter/networkFilterApp";
import { DefaultCodeSignVerifier } from "../../../src/features/networkFilter/NetworkFilterCodeSignVerifier";
import { mapControllerOutcome } from "../../../src/features/networkFilter/NetworkFilterController";
import { DittoFileInstaller } from "../../../src/features/networkFilter/NetworkFilterFileInstaller";
import {
  FakeNetworkFilterCommandRunner,
  FakeNetworkFilterFileSystem,
} from "../../fakes/FakeNetworkFilterHost";

const APP = path.join(path.sep, "Applications", NETWORK_FILTER_APP_NAME);

function outcome(stdout: string, exitCode = 0) {
  return { exitCode, stdout, stderr: "", timedOut: false };
}

describe("mapControllerOutcome", () => {
  test("maps each controller state", () => {
    const line = (state: string, detail = "d") =>
      `${JSON.stringify({ version: 1, state, detail })}\n`;
    expect(mapControllerOutcome(outcome(line("ready"))).state).toBe("ready");
    expect(mapControllerOutcome(outcome(line("ready"), 1)).state).toBe("failed");
    expect(mapControllerOutcome(outcome(line("approval_required"))).nextSteps).toBe(
      NETWORK_FILTER_APPROVAL_STEPS,
    );
    expect(
      mapControllerOutcome(outcome(line("approval_required", "finish after restarting macOS")))
        .state,
    ).toBe("restart_required");
    expect(mapControllerOutcome(outcome(line("unavailable"), 1)).state).toBe("unavailable");
    expect(mapControllerOutcome(outcome(line("installation_required"), 1)).state).toBe("failed");
  });

  test("treats a timeout as unavailable and missing JSON as failed", () => {
    expect(mapControllerOutcome({ ...outcome(""), exitCode: 137, timedOut: true }).state).toBe(
      "unavailable",
    );
    const garbage = mapControllerOutcome({ ...outcome("not json", 1), stderr: "dyld: missing" });
    expect(garbage).toMatchObject({ state: "failed", controllerState: null });
    expect(garbage.detail).toContain("dyld: missing");
  });
});

describe("DefaultCodeSignVerifier", () => {
  test("runs a deep strict verify and inspects the app and its nested provider", async () => {
    const runner = new FakeNetworkFilterCommandRunner();
    runner.handler = (_file, args) =>
      args[0] === "--verify" ? { exitCode: 1, stderr: "a sealed resource is missing" } : {};

    const inspection = await new DefaultCodeSignVerifier(runner).inspect(APP);

    expect(runner.calls.map((call) => [call.file, ...call.args])).toEqual([
      ["codesign", "--verify", "--deep", "--strict", APP],
      ["codesign", "-dvvv", APP],
      ["codesign", "-dvvv", providerPath(APP)],
    ]);
    expect(inspection.verified).toBe(false);
    expect(inspection.verifyDetail).toBe("a sealed resource is missing");
    expect(inspection.app).toEqual({ identifier: null, teamIdentifier: null, cdhash: null });
  });
});

describe("DittoFileInstaller", () => {
  test("copies through a staging path and then swaps it into place", async () => {
    const runner = new FakeNetworkFilterCommandRunner();
    const fileSystem = new FakeNetworkFilterFileSystem();
    runner.handler = (_file, args) => {
      fileSystem.addApp(String(args[1]));
      return {};
    };
    const source = path.join(path.sep, "cache", NETWORK_FILTER_APP_NAME);

    await new DittoFileInstaller(runner, fileSystem).install(source, APP, { replace: false });

    const staging = path.join(path.dirname(APP), `.${NETWORK_FILTER_APP_NAME}.partial`);
    expect(runner.calls[0]?.args).toEqual([source, staging]);
    expect(await fileSystem.isDirectory(APP)).toBe(true);
    expect(await fileSystem.isDirectory(staging)).toBe(false);
  });

  test("refuses to overwrite without replace and cleans up a failed copy", async () => {
    const runner = new FakeNetworkFilterCommandRunner();
    const fileSystem = new FakeNetworkFilterFileSystem();
    fileSystem.addApp(APP);
    const installer = new DittoFileInstaller(runner, fileSystem);

    await expect(installer.install("/src.app", APP, { replace: false })).rejects.toThrow(
      "Refusing to overwrite",
    );
    expect(runner.calls).toHaveLength(0);

    runner.handler = () => ({ exitCode: 1, stderr: "Permission denied" });
    await expect(installer.install("/src.app", APP, { replace: true })).rejects.toThrow(
      "Permission denied",
    );
    expect(await fileSystem.isDirectory(APP)).toBe(true);
  });
});
