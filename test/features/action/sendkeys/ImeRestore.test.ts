import { createExecResult } from "../../../../src/utils/execResult";
import { TypingSession } from "../../../../src/features/action/sendkeys/TypingSession";
import { describe, expect, test } from "bun:test";
import {
  ImeRestore,
  type ImeRestoreHost,
} from "../../../../src/features/action/sendkeys/ImeRestore";
import { AUTO_MOBILE_IME_ID } from "../../../../src/features/action/AndroidImeCatalog";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

function harness() {
  const adb = new FakeAdbExecutor();
  const calls: string[] = [];
  const host: ImeRestoreHost = {
    session: new TypingSession(),
    adb,
    device: { deviceId: "ime-restore-unit" },
    textClient: {
      supportsKeyboardProfiles: async () => true,
      setKeyboardProfile: async (id) => {
        calls.push(id);
        return { success: true };
      },
    },
    checkAbort: (signal, error) => {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
    },
  };
  return { restoration: new ImeRestore(host), adb, calls, host };
}

describe("ImeRestore", () => {
  test("requires a pinned user, then reads every IME command for the current pinned user", async () => {
    const { restoration, host, adb } = harness();
    expect(() => restoration.imeUserFlag()).toThrow(
      "IME user was not pinned before an IME command.",
    );
    host.session.imeUserId = 10;
    adb.setCommandResponse(
      "shell settings --user 10 get secure default_input_method",
      createExecResult("keyboard/.Ime\n", ""),
    );
    expect(await restoration.readDefaultIme()).toEqual({ success: true, imeId: "keyboard/.Ime" });
    host.session.imeUserId = 0;
    expect(restoration.imeUserFlag()).toBe("");
    expect(await restoration.readDefaultIme()).toEqual({ success: true, imeId: null });
    expect(adb.getExecutedCommands()).toEqual([
      "shell settings --user 10 get secure default_input_method",
      "shell settings get secure default_input_method",
    ]);
  });

  test("does not report activation success until the default IME read-back matches", async () => {
    const { restoration, host, adb } = harness();
    host.session.imeUserId = 10;
    adb.setCommandResponse(
      "shell settings --user 10 get secure default_input_method",
      createExecResult(AUTO_MOBILE_IME_ID, ""),
    );
    expect(await restoration.activateCommitIme(false)).toBe(true);
    expect(adb.getExecutedCommands()).toEqual([
      `shell ime enable --user 10 ${AUTO_MOBILE_IME_ID}`,
      `shell ime set --user 10 ${AUTO_MOBILE_IME_ID}`,
      "shell settings --user 10 get secure default_input_method",
    ]);
    adb.setCommandResponse(
      "shell settings --user 10 get secure default_input_method",
      createExecResult("keyboard/.Ime", ""),
    );
    expect(await restoration.activateCommitIme(true)).toBe(false);
  });

  test("restores a changed keyboard profile after fake asynchronous profile selection", async () => {
    const { restoration, host, calls } = harness();
    const timer = new FakeTimer();
    host.textClient.setKeyboardProfile = async (id) => {
      calls.push(id);
      await timer.sleep(1);
      return { success: true, previousProfileId: "direct" };
    };
    const pending = restoration.setRequestedKeyboardProfile("gboard");
    timer.advanceTime(1);
    expect(await pending).toEqual({ success: true, previousProfileId: "direct" });
    const restore = restoration.restoreKeyboardProfileIfNeeded("gboard", "direct");
    timer.advanceTime(1);
    await restore;
    expect(calls).toEqual(["gboard", "direct"]);
    await restoration.restoreKeyboardProfileIfNeeded("direct", "direct");
    expect(calls).toHaveLength(2);
  });

  test("does not switch or disable an IME that was already selected", async () => {
    const { restoration, adb } = harness();
    await restoration.restoreIme(AUTO_MOBILE_IME_ID, true, { id: 7 });
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("recovery re-disables a commit IME left enabled by a failed restoration (#13158)", async () => {
    const { restoration, adb } = harness();
    const original = "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME";
    adb.setCommandResponse(
      "shell ime list -a -s",
      createExecResult(`${original}\n${AUTO_MOBILE_IME_ID}\n`, ""),
    );
    adb.setCommandResponseSequence("shell ime list -s", [
      createExecResult(`${original}\n${AUTO_MOBILE_IME_ID}\n`, ""),
      createExecResult(`${original}\n`, ""),
    ]);
    adb.setCommandResponse(
      "shell settings get secure default_input_method",
      createExecResult(`${original}\n`, ""),
    );
    adb.setCommandResponse(
      "shell settings get secure default_input_method_subtype",
      createExecResult("null\n", ""),
    );
    adb.setCommandResponse(`shell ime disable ${AUTO_MOBILE_IME_ID}`, createExecResult("", ""));
    const recovered = await restoration.verifySafeImeRecovery({
      imeId: original,
      subtypeId: null,
      wasEnabled: false,
      userId: 0,
    });
    expect(recovered).toBe(true);
    expect(adb.getExecutedCommands()).toContain(`shell ime disable ${AUTO_MOBILE_IME_ID}`);
  });
});
