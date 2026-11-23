import { describe, expect, test } from "bun:test";
import { IosDeviceMutationResetPort } from "../../../src/daemon/sessionBroker/mutations/iosResetPort";
import type { DeviceMutationResetContext } from "../../../src/daemon/sessionBroker/mutations/reset";
import type {
  DeviceMutationInput,
  MutationValue,
} from "../../../src/daemon/sessionBroker/mutations/types";
import type { ExecResult } from "../../../src/models/ExecResult";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeIosResidueInspector } from "../../fakes/FakeIosResidueInspector";
import { FakeSimulatorKeyboardBridge } from "../../fakes/FakeSimulatorKeyboardBridge";
import { FakeTimer } from "../../fakes/FakeTimer";

const UDID = "11111111-2222-4333-8444-555555555555";

function rig() {
  const commands: string[][] = [];
  const keyboard = new FakeSimulatorKeyboardBridge();
  const unused = async () => {
    throw new Error("unused in this test");
  };
  const port = new IosDeviceMutationResetPort(
    {
      simctl: {
        listAppsOrThrow: unused,
        executeCommandArgs: async (args): Promise<ExecResult> => {
          commands.push(args);
          return createExecResult("", "");
        },
      },
      files: { realpath: unused, remove: unused },
      pasteboard: { assertSettled: () => {}, write: unused },
      privacyGrants: { readServiceRows: unused },
      trustStore: { readUserTrustedCertificates: unused },
      residue: new FakeIosResidueInspector(),
      storeKit: { clear: async () => {} },
      keyboard,
    },
    new FakeTimer(),
  );
  const context: DeviceMutationResetContext = {
    scope: { deviceId: UDID, incarnation: "generation-1", sessionUuid: "session-a" },
    signal: new AbortController().signal,
    assertOwned: async () => {},
  };
  return { port, context, commands, keyboard };
}

const row = (key: string, priorValue: MutationValue): DeviceMutationInput => ({
  kind: "keyboard",
  key,
  priorValue,
  toolName: "setDeviceState",
});

const LANGUAGE_PRIOR = {
  keyboards: ["en_US@sw=QWERTY;hw=Automatic", "emoji@sw=Emoji"],
  languages: ["en-US"],
  current: "en_US@sw=QWERTY;hw=Automatic",
  locale: "en_US",
};

const defaults = (...rest: string[]) => ["spawn", UDID, "defaults", ...rest];

describe("iOS keyboard revert (#19017)", () => {
  test("the hardware keyboard goes back to the boot state", async () => {
    const { port, context, keyboard } = rig();
    await port.revert(
      row("hardware", { state: "present", value: { connected: true, layout: "ansi" } }),
      context,
    );
    expect(keyboard.calls).toEqual([
      { call: "hardware", udid: UDID, connected: true, layout: "ansi" },
    ]);
  });

  test("a language change selects the prior keyboard, then writes back what it rewrote", async () => {
    const { port, context, commands, keyboard } = rig();
    await port.revert(row("language", { state: "present", value: LANGUAGE_PRIOR }), context);
    expect(keyboard.calls).toEqual([{ call: "language", udid: UDID, language: "en_US" }]);
    expect(commands).toEqual([
      defaults(
        "write",
        ".GlobalPreferences",
        "AppleKeyboards",
        "-array",
        "en_US@sw=QWERTY;hw=Automatic",
        "emoji@sw=Emoji",
      ),
      defaults("write", ".GlobalPreferences", "AppleLanguages", "-array", "en-US"),
      defaults(
        "write",
        "com.apple.keyboard.preferences",
        "KeyboardLastUsed",
        "-string",
        "en_US@sw=QWERTY;hw=Automatic",
      ),
    ]);
  });

  test("a new simulator's unset keyboards and selection are deleted, selecting the locale", async () => {
    const { port, context, commands, keyboard } = rig();
    await port.revert(
      row("language", {
        state: "present",
        value: { keyboards: null, languages: ["en-US"], current: null, locale: "en_US" },
      }),
      context,
    );
    expect(keyboard.calls).toEqual([{ call: "language", udid: UDID, language: "en_US" }]);
    expect(commands).toEqual([
      defaults("delete", ".GlobalPreferences", "AppleKeyboards"),
      defaults("write", ".GlobalPreferences", "AppleLanguages", "-array", "en-US"),
      defaults("delete", "com.apple.keyboard.preferences", "KeyboardLastUsed"),
    ]);
  });

  test("an unset or emoji selection falls back to the first language keyboard", async () => {
    const { port, context, keyboard } = rig();
    await port.revert(
      row("language", {
        state: "present",
        value: {
          keyboards: ["emoji@sw=Emoji", "ja_JP-Kana@sw=Kana;hw=Automatic"],
          languages: ["ja-JP"],
          current: null,
          locale: "en_US",
        },
      }),
      context,
    );
    expect(keyboard.calls).toEqual([{ call: "language", udid: UDID, language: "ja_JP-Kana" }]);
  });

  test("a failed CoreSimulator call fails the revert so keep-booted reset escalates", async () => {
    const { port, context, keyboard } = rig();
    keyboard.failWith = new Error("device-not-booted");
    await expect(
      port.revert(
        row("hardware", { state: "present", value: { connected: true, layout: "ansi" } }),
        context,
      ),
    ).rejects.toThrow("device-not-booted");
  });

  test("only well-formed priors are revertible", () => {
    const { port } = rig();
    expect(port.canRevert(row("language", { state: "present", value: LANGUAGE_PRIOR }))).toBe(true);
    expect(
      port.canRevert(
        row("hardware", { state: "present", value: { connected: false, layout: "jis" } }),
      ),
    ).toBe(true);
    expect(port.canRevert(row("language", { state: "unobservable" }))).toBe(false);
    expect(port.canRevert(row("language", { state: "absent" }))).toBe(false);
    expect(
      port.canRevert(
        row("language", { state: "present", value: { ...LANGUAGE_PRIOR, keyboards: [] } }),
      ),
    ).toBe(false);
    expect(
      port.canRevert(
        row("language", {
          state: "present",
          value: { keyboards: ["emoji@sw=Emoji"], languages: null, current: null, locale: null },
        }),
      ),
    ).toBe(false);
    expect(port.canRevert(row("defaults", { state: "present", value: {} }))).toBe(false);
  });
});
