import { describe, expect, test } from "bun:test";
import { IosDeviceMutationResetPort } from "../../../src/daemon/sessionBroker/mutations/iosResetPort";
import type { DeviceMutationResetContext } from "../../../src/daemon/sessionBroker/mutations/reset";
import type {
  DeviceMutationInput,
  MutationValue,
} from "../../../src/daemon/sessionBroker/mutations/types";
import type { ExecResult } from "../../../src/models/ExecResult";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";

const UDID = "11111111-2222-4333-8444-555555555555";
const KEY = "com.apple.BiometricKit.enrollmentChanged";

function rig(notifyutilStdout: (enrolled: string) => string) {
  const commands: string[][] = [];
  const unused = async () => {
    throw new Error("unused in this test");
  };
  const port = new IosDeviceMutationResetPort(
    {
      simctl: {
        listAppsOrThrow: unused,
        executeCommandArgs: async (args): Promise<ExecResult> => {
          commands.push(args);
          return createExecResult(notifyutilStdout(args[7] ?? ""), "");
        },
      },
      files: { realpath: unused, remove: unused },
      pasteboard: { assertSettled: () => {}, write: unused },
      privacyGrants: { readServiceRows: unused },
      trustStore: { readUserTrustedCertificates: unused },
    },
    new FakeTimer(),
  );
  const context: DeviceMutationResetContext = {
    scope: { deviceId: UDID, incarnation: "generation-1", sessionUuid: "session-a" },
    signal: new AbortController().signal,
    assertOwned: async () => {},
  };
  return { port, context, commands };
}

const biometric = (priorValue: MutationValue, key = "device"): DeviceMutationInput => ({
  kind: "biometric-enrollment",
  key,
  priorValue,
  toolName: "setDeviceState",
});

describe("iOS biometric enrollment revert", () => {
  test("a not_enrolled prior is registered, set, read back and posted in one notifyutil process", async () => {
    const { port, context, commands } = rig(() => `${KEY} 0\n`);
    await port.revert(biometric({ state: "present", value: "not_enrolled" }), context);
    expect(commands).toEqual([
      ["spawn", UDID, "notifyutil", "-1", KEY, "-s", KEY, "0", "-g", KEY, "-p", KEY],
    ]);
  });

  test("an enrolled prior is written back as 1", async () => {
    const { port, context, commands } = rig(() => `${KEY} 1\n`);
    await port.revert(biometric({ state: "present", value: "enrolled" }), context);
    expect(commands[0]?.[7]).toBe("1");
  });

  test("a state that does not read back as the prior fails the revert so keep-booted escalates", async () => {
    const { port, context } = rig(() => `${KEY} 1\n`);
    await expect(
      port.revert(biometric({ state: "present", value: "not_enrolled" }), context),
    ).rejects.toThrow("did not read back");
  });

  test("an unreadable, absent, foreign or transient-auth prior cannot be restored", () => {
    const { port } = rig(() => "");
    expect(port.canRevert(biometric({ state: "unobservable" }))).toBe(false);
    expect(port.canRevert(biometric({ state: "absent" }))).toBe(false);
    expect(port.canRevert(biometric({ state: "present", value: "maybe" }))).toBe(false);
    expect(
      port.canRevert(biometric({ state: "present", value: "enrolled" }, "auth-override")),
    ).toBe(false);
    expect(port.canRevert(biometric({ state: "present", value: "enrolled" }))).toBe(true);
  });
});
