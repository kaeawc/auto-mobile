import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  CoreDeviceCapabilityProbe,
  parseCoreDeviceVersion,
} from "../../../src/utils/ios-cmdline-tools/CoreDeviceCapabilityProbe";
import {
  FakeDevicectlVersionSource,
  FakeDevicectlCommandInvoker,
  FakeSimulatorBootStateProvider,
} from "../../fakes/FakeCoreDeviceCapabilityDependencies";

import { parseDevicectlFailureEnvelope } from "../../../src/utils/ios-cmdline-tools/devicectlFailureEnvelope";

const capturedVersion = readFileSync(
  join(process.cwd(), "test/fixtures/ios-devicectl/version.txt"),
  "utf8",
);
const COREDEVICE_MEMO_LIMIT = 64;
const installed: [number, number, number] = [651, 13, 4];
const required: [number, number, number] = [651, 13, 4];

function harness(options: { scope?: string } = {}) {
  const versionSource = new FakeDevicectlVersionSource(capturedVersion);
  const bootState = new FakeSimulatorBootStateProvider();
  if (options.scope) {
    bootState.getCapabilityScope = () => options.scope!;
  }
  const commandInvoker = new FakeDevicectlCommandInvoker();
  const warnings: string[] = [];
  const probe = new CoreDeviceCapabilityProbe({
    versionSource,
    bootState,
    commandInvoker,
    logger: { warn: (message) => warnings.push(message) },
  });
  return { probe, versionSource, bootState, commandInvoker, warnings };
}

describe("CoreDeviceCapabilityProbe", () => {
  test("parses the captured CoreDevice version and compares the required version", async () => {
    expect(parseCoreDeviceVersion(capturedVersion)).toEqual(installed);
    const { probe, commandInvoker } = harness();
    expect(await probe.checkSimulatorCommand("sim-1", "lock-state", [651, 13, 5])).toEqual({
      kind: "unsupported",
      reason: "lock-state requires CoreDevice >= 651.13.5",
    });
    expect(commandInvoker.calls).toHaveLength(0);
  });

  test("coalesces version calls and caches success for the instance", async () => {
    const { probe, versionSource } = harness();
    const [first, second] = await Promise.all([probe.getVersion(), probe.getVersion()]);
    expect(first).toEqual({ kind: "available", version: installed });
    expect(second).toEqual(first);
    expect(await probe.getVersion()).toEqual(first);
    expect(versionSource.calls).toBe(1);
  });

  test("retries a failed version probe as unavailable and logs it", async () => {
    const { probe, versionSource, warnings } = harness();
    versionSource.failure = new Error("version command failed");
    expect(await probe.getVersion()).toMatchObject({ kind: "unavailable" });
    expect(await probe.getVersion()).toMatchObject({ kind: "unavailable" });
    expect(versionSource.calls).toBe(2);
    expect(warnings[0]).toContain("version command failed");
  });

  test("recordVersion seeds a copied version and a failure invalidates success", async () => {
    const h = harness();
    const version: [number, number, number] = [...installed];
    h.probe.recordVersion({ kind: "available", version });
    version[0] = 0;
    expect(await h.probe.getVersion()).toEqual({ kind: "available", version: installed });
    expect(h.versionSource.calls).toBe(0);
    h.probe.recordVersion({ kind: "unavailable", reason: "read failed", reasonKind: "missing" });
    expect(await h.probe.getVersion()).toEqual({ kind: "available", version: installed });
    expect(h.versionSource.calls).toBe(1);
  });

  test("refresh and command version reads share one in-flight invocation", async () => {
    const h = harness();
    let finish!: (result: { kind: "available"; version: [number, number, number] }) => void;
    let reads = 0;
    const read = () => {
      reads += 1;
      return new Promise<{ kind: "available"; version: [number, number, number] }>((resolve) => {
        finish = resolve;
      });
    };
    const first = h.probe.refreshVersion(read);
    const second = h.probe.refreshVersion(read);
    const command = h.probe.checkSimulatorCommand("sim-1", "info displays", required);
    for (let turn = 0; turn < 8; turn += 1) {
      await Promise.resolve();
    }
    finish({ kind: "available", version: installed });
    expect(await first).toEqual(await second);
    expect((await command).kind).toBe("supported");
    expect(reads).toBe(1);
    expect(h.versionSource.calls).toBe(0);
    await h.probe.refreshVersion(async () => {
      reads += 1;
      return { kind: "available", version: installed };
    });
    expect(reads).toBe(2);
  });

  test("an older in-flight read cannot overwrite a newly recorded failure", async () => {
    const h = harness();
    let finish!: (result: { kind: "available"; version: [number, number, number] }) => void;
    const pending = h.probe.refreshVersion(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    h.probe.recordVersion({ kind: "unavailable", reason: "new failure", reasonKind: "missing" });
    finish({ kind: "available", version: installed });
    expect(await pending).toMatchObject({ kind: "unavailable", reason: "new failure" });
    expect(h.probe.getCachedVersion()).toMatchObject({ kind: "unavailable" });
  });

  test("blocks shut-down or unknown simulator states before command invocation", async () => {
    const { probe, bootState, commandInvoker } = harness();
    bootState.state = "shutdown";
    const shutdown = await probe.checkSimulatorCommand("sim-1", "copy", required);
    expect(shutdown.kind).toBe("notBooted");
    if (shutdown.kind === "notBooted") {
      expect(shutdown.error).toBeInstanceOf(ActionableError);
      expect(shutdown.error.message).toContain("Boot it before running copy");
    }
    bootState.state = "unknown";
    expect(await probe.checkSimulatorCommand("sim-1", "copy", required)).toMatchObject({
      kind: "notBooted",
    });
    expect(commandInvoker.calls).toHaveLength(0);
  });

  test("memoizes a captured feature ID rather than a localized command failure", async () => {
    const { probe, commandInvoker } = harness();
    const envelope = parseDevicectlFailureEnvelope(
      JSON.parse(
        readFileSync(
          join(
            process.cwd(),
            "test/fixtures/ios-devicectl/info-lockstate-booted-simulator-1001.json",
          ),
          "utf8",
        ),
      ),
    )!;
    commandInvoker.result = {
      kind: "unsupported",
      capabilityFeatureId: envelope.capabilityFeatureId!,
    };
    await probe.checkSimulatorCommand("sim-1", "info lockState", required);
    await probe.checkSimulatorCommand("sim-1", "info lockState", required);
    expect(commandInvoker.calls).toHaveLength(1);
    expect(probe.getCapabilities().entries).toMatchObject([
      { featureId: envelope.capabilityFeatureId, status: "unsupported" },
    ]);
  });

  test.each(["shutdown", "unknown"] as const)(
    "checks %s before even the version probe and never memoizes it",
    async (state) => {
      const { probe, bootState, commandInvoker, versionSource } = harness();
      bootState.state = state;
      expect((await probe.checkSimulatorCommand("sim-1", "info lockState", required)).kind).toBe(
        "notBooted",
      );
      expect(versionSource.calls).toBe(0);
      expect(commandInvoker.calls).toHaveLength(0);
      bootState.state = "booted";
      expect((await probe.checkSimulatorCommand("sim-1", "info lockState", required)).kind).toBe(
        "supported",
      );
      expect(commandInvoker.calls).toHaveLength(1);
    },
  );
  test("same feature across two learned commands shares one typed memo; different simulator kinds remain independent", async () => {
    const h = harness({ scope: "iPhone.nonDuo" });
    for (const [command, capture] of [
      ["motion hinge-angle", "motion-hinge-angle-booted-nonduo-simulator-1001"],
      ["motion hinge-angle --verbose", "motion-hinge-angle-shutdown-simulator-1001"],
    ]) {
      // Shutdown capture is envelope evidence only; injected boot state is booted.
      const envelope = parseDevicectlFailureEnvelope(
        JSON.parse(
          readFileSync(join(process.cwd(), `test/fixtures/ios-devicectl/${capture}.json`), "utf8"),
        ),
      )!;
      h.commandInvoker.result = {
        kind: "unsupported",
        capabilityFeatureId: envelope.capabilityFeatureId!,
      };
      await h.probe.checkSimulatorCommand("sim-1", command, required);
    }
    for (const command of ["motion hinge-angle", "motion hinge-angle --verbose"]) {
      await h.probe.checkSimulatorCommand("sim-2", command, required);
    }
    expect(h.commandInvoker.calls).toHaveLength(2);
    expect(new Set(h.probe.getCapabilities().entries.map((entry) => entry.featureId)).size).toBe(1);
    h.bootState.getCapabilityScope = () => "iPhone.Duo";
    h.commandInvoker.result = { kind: "ok" };
    expect(
      (await h.probe.checkSimulatorCommand("sim-duo", "motion hinge-angle", required)).kind,
    ).toBe("supported");
    expect(h.commandInvoker.calls).toHaveLength(3);
  });

  test("supported passes each invocation's output through without memoizing it", async () => {
    const h = harness();
    h.commandInvoker.result = { kind: "ok", output: "first listing" };
    expect(await h.probe.checkSimulatorCommand("sim-1", "info displays", required)).toEqual({
      kind: "supported",
      output: "first listing",
    });
    h.commandInvoker.result = { kind: "ok", output: "second listing" };
    expect(await h.probe.checkSimulatorCommand("sim-1", "info displays", required)).toEqual({
      kind: "supported",
      output: "second listing",
    });
    expect(h.commandInvoker.calls).toHaveLength(2);
    expect(h.probe.getCapabilities().entries).toEqual([
      { scope: "sim-1", command: "info displays", status: "supported" },
    ]);
  });

  test("unsupported without a feature ID and all failed results are retried", async () => {
    const h = harness();
    for (const result of [
      { kind: "unsupported" as const },
      ...["non-1001", "nonzero exit", "timeout", "unparsable"].map((message) => ({
        kind: "failed" as const,
        message,
      })),
    ]) {
      h.commandInvoker.result = result;
      await h.probe.checkSimulatorCommand("sim-1", "info lockState", required);
      await h.probe.checkSimulatorCommand("sim-1", "info lockState", required);
    }
    expect(h.commandInvoker.calls).toHaveLength(10);
    expect(h.probe.getCapabilities()).toEqual({ status: "not probed", entries: [] });
  });

  test("bounds command links and scoped features with FIFO eviction", async () => {
    const h = harness();
    const featureId = parseDevicectlFailureEnvelope(
      JSON.parse(
        readFileSync(
          join(
            process.cwd(),
            "test/fixtures/ios-devicectl/info-files-appdatacontainer-booted-simulator-1001.json",
          ),
          "utf8",
        ),
      ),
    )!.capabilityFeatureId!;
    h.commandInvoker.result = { kind: "unsupported", capabilityFeatureId: featureId };
    for (let index = 0; index <= COREDEVICE_MEMO_LIMIT; index += 1) {
      await h.probe.checkSimulatorCommand(`sim-${index}`, "info files", required);
    }
    expect(h.probe.getCapabilities().entries).toHaveLength(COREDEVICE_MEMO_LIMIT);
    await h.probe.checkSimulatorCommand("sim-0", "info files", required);
    expect(h.commandInvoker.calls).toHaveLength(COREDEVICE_MEMO_LIMIT + 2);
    const shared = harness({ scope: "nonDuo" });
    shared.commandInvoker.result = h.commandInvoker.result;
    for (let index = 0; index <= COREDEVICE_MEMO_LIMIT; index += 1) {
      await shared.probe.checkSimulatorCommand("sim-1", `info files ${index}`, required);
    }
    expect(shared.probe.getCapabilities().entries).toHaveLength(COREDEVICE_MEMO_LIMIT);
    await shared.probe.checkSimulatorCommand("sim-1", "info files 0", required);
    expect(shared.commandInvoker.calls).toHaveLength(COREDEVICE_MEMO_LIMIT + 2);
  });

  test("coalesces concurrent commands through SingleFlight", async () => {
    const h = harness();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        h.probe.checkSimulatorCommand("sim-1", "info displays", required),
      ),
    );
    expect(h.commandInvoker.calls).toHaveLength(1);
    expect(h.probe.getCapabilities().entries).toMatchObject([
      { command: "info displays", status: "supported" },
    ]);
  });
});
