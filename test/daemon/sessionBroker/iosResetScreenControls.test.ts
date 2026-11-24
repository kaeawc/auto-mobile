import { describe, expect, test } from "bun:test";
import { IosDeviceMutationResetPort } from "../../../src/daemon/sessionBroker/mutations/iosResetPort";
import type { DeviceMutationResetContext } from "../../../src/daemon/sessionBroker/mutations/reset";
import type {
  DeviceMutationInput,
  MutationValue,
} from "../../../src/daemon/sessionBroker/mutations/types";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIosResidueInspector } from "../../fakes/FakeIosResidueInspector";
import { FakeSimulatorKeyboardBridge } from "../../fakes/FakeSimulatorKeyboardBridge";
import { hiddenDynamicIslands } from "../../../src/utils/ios-cmdline-tools/SimulatorDynamicIsland";

function harness(commandError?: (args: string[]) => Error | undefined) {
  const commands: string[][] = [];
  const backlight: Array<{ udid: string; active: boolean }> = [];
  const port = new IosDeviceMutationResetPort(
    {
      simctl: {
        listAppsOrThrow: async () => [],
        executeCommandArgs: async (args) => {
          commands.push(args);
          const error = commandError?.(args);
          if (error) {
            throw error;
          }
          return createExecResult("", "");
        },
      },
      privacyGrants: { readServiceRows: async () => [] },
      residue: new FakeIosResidueInspector(),
      storeKit: { clear: async () => {} },
      trustStore: { readUserTrustedCertificates: async () => [] },
      files: { realpath: async (path) => path, remove: async () => {} },
      pasteboard: { assertSettled: () => {}, write: async () => {} },
      keyboard: new FakeSimulatorKeyboardBridge(),
      backlight: {
        setActive: async (udid, active) => {
          backlight.push({ udid, active });
        },
      },
    },
    new FakeTimer(),
  );
  const context: DeviceMutationResetContext = {
    scope: { deviceId: "UDID", incarnation: "generation", sessionUuid: "session" },
    signal: new AbortController().signal,
    assertOwned: async () => {},
  };
  return { port, context, commands, backlight };
}

function row(key: string, priorValue: MutationValue): DeviceMutationInput {
  return { kind: "device-setting", key, priorValue, toolName: "displayConfig" };
}

describe("iOS reset of the Simulator Dynamic Island and backlight (#19018)", () => {
  test("only a boolean or absent island prior and a boolean backlight prior can revert", () => {
    const { port } = harness();
    expect(port.canRevert(row("dynamicIsland", { state: "absent" }))).toBe(true);
    expect(port.canRevert(row("dynamicIsland", { state: "present", value: false }))).toBe(true);
    expect(port.canRevert(row("dynamicIsland", { state: "present", value: "1" }))).toBe(false);
    expect(port.canRevert(row("dynamicIsland", { state: "unobservable" }))).toBe(false);
    expect(port.canRevert(row("backlight", { state: "present", value: true }))).toBe(true);
    expect(port.canRevert(row("backlight", { state: "absent" }))).toBe(false);
  });

  test("an absent island default is deleted again and a recorded one is written back", async () => {
    const { port, context, commands } = harness();

    await port.revert(row("dynamicIsland", { state: "absent" }), context);
    await port.revert(row("dynamicIsland", { state: "present", value: true }), context);

    expect(commands).toEqual([
      [
        "spawn",
        "UDID",
        "defaults",
        "delete",
        "com.apple.springboard",
        "SBSuppressDynamicIslandCompletely",
      ],
      [
        "spawn",
        "UDID",
        "defaults",
        "write",
        "com.apple.springboard",
        "SBSuppressDynamicIslandCompletely",
        "-bool",
        "YES",
      ],
    ]);
  });

  test("a revert tells later screenshots whether the island stays hidden", async () => {
    const { port, context } = harness();
    hiddenDynamicIslands.set("UDID", true);

    await port.revert(row("dynamicIsland", { state: "absent" }), context);
    expect(hiddenDynamicIslands.has("UDID")).toBe(false);

    await port.revert(row("dynamicIsland", { state: "present", value: true }), context);
    expect(hiddenDynamicIslands.has("UDID")).toBe(true);
    hiddenDynamicIslands.set("UDID", false);
  });

  test("deleting an island default that is already gone succeeds", async () => {
    const { port, context } = harness(
      () =>
        new Error(
          "Could not find key 'SBSuppressDynamicIslandCompletely' in domain 'com.apple.springboard'.",
        ),
    );

    await port.revert(row("dynamicIsland", { state: "absent" }), context);
  });

  test("the backlight reverts through CoreSimulator, not simctl", async () => {
    const { port, context, commands, backlight } = harness();

    await port.revert(row("backlight", { state: "present", value: true }), context);

    expect(backlight).toEqual([{ udid: "UDID", active: true }]);
    expect(commands).toEqual([]);
  });
});
