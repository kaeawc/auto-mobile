import { describe, expect, test } from "bun:test";
import { IosDeviceMutationResetPort } from "../../../src/daemon/sessionBroker/mutations/iosResetPort";
import type { DeviceMutationResetContext } from "../../../src/daemon/sessionBroker/mutations/reset";
import type { DeviceMutationInput } from "../../../src/daemon/sessionBroker/mutations/types";
import { DefaultMutationPriorReader } from "../../../src/server/deviceMutationPriorReader";
import type { BootedDevice } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIosResidueInspector } from "../../fakes/FakeIosResidueInspector";
import { FakeSimulatorKeyboardBridge } from "../../fakes/FakeSimulatorKeyboardBridge";
import { FakeSimulatorRenderOverlayControl } from "../../fakes/FakeSimulatorRenderOverlayControl";

const UDID = "12345678-1234-1234-1234-123456789ABC";

function harness(withOverlays = true) {
  const overlays = new FakeSimulatorRenderOverlayControl();
  const commands: string[][] = [];
  const port = new IosDeviceMutationResetPort(
    {
      simctl: {
        listAppsOrThrow: async () => [],
        executeCommandArgs: async (args) => {
          commands.push(args);
          return {
            stdout: "",
            stderr: "",
            toString: () => "",
            trim: () => "",
            includes: () => false,
          };
        },
      },
      privacyGrants: { readServiceRows: async () => [] },
      residue: new FakeIosResidueInspector(),
      storeKit: { clear: async () => {} },
      keyboard: new FakeSimulatorKeyboardBridge(),
      trustStore: { readUserTrustedCertificates: async () => [] },
      files: { realpath: async (path) => path, remove: async () => {} },
      pasteboard: { assertSettled: () => {}, write: async () => {} },
      ...(withOverlays ? { renderOverlays: overlays } : {}),
    },
    new FakeTimer(),
  );
  const phases: string[] = [];
  const context: DeviceMutationResetContext = {
    scope: { deviceId: UDID, incarnation: "generation", sessionUuid: "session" },
    signal: new AbortController().signal,
    assertOwned: async () => {},
    recordPhase: (phase) => phases.push(phase),
  };
  return { port, overlays, commands, context, phases };
}

function overlayRow(prior: DeviceMutationInput["priorValue"]): DeviceMutationInput {
  return {
    kind: "device-setting",
    key: "renderOverlay:blendedLayers",
    priorValue: prior,
    toolName: "displayConfig",
  };
}

describe("iOS keep-booted reset restores Simulator render overlays (#19016)", () => {
  test("reverts an overlay row to its prior state through CoreSimulator, not simctl", async () => {
    const rig = harness();
    rig.overlays.states.set(UDID, { ...rig.overlays.state(UDID), blendedLayers: true });

    const row = overlayRow({ state: "present", value: false });
    expect(rig.port.canRevert(row)).toBe(true);
    await rig.port.revert(row, rig.context);

    expect(rig.overlays.writes).toEqual([{ udid: UDID, values: { blendedLayers: false } }]);
    expect(rig.overlays.state(UDID).blendedLayers).toBe(false);
    expect(rig.commands).toEqual([]);
    expect(rig.phases).toEqual(["coresimulator:ca-debug"]);
  });

  test("an unobservable or non-boolean prior cannot revert", () => {
    const rig = harness();
    expect(rig.port.canRevert(overlayRow({ state: "unobservable" }))).toBe(false);
    expect(rig.port.canRevert(overlayRow({ state: "absent" }))).toBe(false);
    expect(rig.port.canRevert(overlayRow({ state: "present", value: "off" }))).toBe(false);
  });

  test("a restore that does not read back fails the revert", async () => {
    const rig = harness();
    rig.overlays.states.set(UDID, { ...rig.overlays.state(UDID), blendedLayers: true });
    rig.overlays.stuck.add("blendedLayers");

    await expect(
      rig.port.revert(overlayRow({ state: "present", value: false }), rig.context),
    ).rejects.toThrow("did not read back as restored");
  });

  test("without an overlay control the revert fails instead of reporting clean", async () => {
    const rig = harness(false);

    await expect(
      rig.port.revert(overlayRow({ state: "present", value: false }), rig.context),
    ).rejects.toThrow("cannot restore render overlay");
  });
});

describe("render overlay priors (#19016)", () => {
  const simulator: BootedDevice = { name: "iPhone", platform: "ios", deviceId: UDID };

  test("reads every overlay row from one CoreSimulator read", async () => {
    const overlays = new FakeSimulatorRenderOverlayControl();
    overlays.states.set(UDID, { ...overlays.state(UDID), offscreenRendered: true });
    const reader = new DefaultMutationPriorReader({ renderOverlays: overlays });

    const priors = await reader.read(simulator, [
      { kind: "device-setting", key: "renderOverlay:blendedLayers" },
      { kind: "device-setting", key: "renderOverlay:offscreenRendered" },
    ]);

    expect(priors).toEqual([
      { state: "present", value: false },
      { state: "present", value: true },
    ]);
    expect(overlays.reads).toEqual([UDID]);
  });

  test("an unreadable overlay state is unobservable", async () => {
    const overlays = new FakeSimulatorRenderOverlayControl();
    overlays.failure = new Error("CoreSimulator unavailable");
    const reader = new DefaultMutationPriorReader({ renderOverlays: overlays });

    const priors = await reader.read(simulator, [
      { kind: "device-setting", key: "renderOverlay:blendedLayers" },
    ]);

    expect(priors).toEqual([{ state: "unobservable" }]);
  });

  test("a physical iOS device is never read", async () => {
    const overlays = new FakeSimulatorRenderOverlayControl();
    const reader = new DefaultMutationPriorReader({ renderOverlays: overlays });

    const priors = await reader.read(
      { name: "iPhone", platform: "ios", deviceId: "00008130-001234567890ABCD" },
      [{ kind: "device-setting", key: "renderOverlay:blendedLayers" }],
    );

    expect(priors).toEqual([{ state: "unobservable" }]);
    expect(overlays.reads).toEqual([]);
  });
});

describe("iOS release restores all overlay rows of a device in one call (#19016)", () => {
  test("revertRenderOverlays writes every row through one CoreSimulator set", async () => {
    const rig = harness();
    rig.overlays.states.set(UDID, {
      ...rig.overlays.state(UDID),
      blendedLayers: true,
      cacheHits: true,
    });
    const rows: DeviceMutationInput[] = [
      { ...overlayRow({ state: "present", value: false }), key: "renderOverlay:cacheHits" },
      overlayRow({ state: "present", value: false }),
    ];

    await rig.port.revertRenderOverlays(rows, rig.context);

    expect(rig.overlays.writes).toEqual([
      { udid: UDID, values: { cacheHits: false, blendedLayers: false } },
    ]);
    expect(rig.overlays.state(UDID).cacheHits).toBe(false);
    expect(rig.phases).toEqual(["coresimulator:ca-debug"]);
  });

  test("a row that did not read back as restored fails the batch", async () => {
    const rig = harness();
    rig.overlays.states.set(UDID, { ...rig.overlays.state(UDID), blendedLayers: true });
    rig.overlays.stuck.add("blendedLayers");

    await expect(
      rig.port.revertRenderOverlays([overlayRow({ state: "present", value: false })], rig.context),
    ).rejects.toThrow("did not read back as restored");
  });
});
