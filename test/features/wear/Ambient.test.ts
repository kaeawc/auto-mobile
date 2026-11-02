import { describe, expect, test } from "bun:test";
import {
  AdbAmbient,
  type AmbientAdb,
  type AmbientAction,
} from "../../../src/features/wear/Ambient";
import { ActionableError, type ExecResult } from "../../../src/models";

class FakeAmbientAdb implements AmbientAdb {
  readonly calls: string[] = [];
  wakefulness: "Awake" | "Asleep" | "Dozing" | null = "Dozing";
  error?: Error;
  readError?: Error;

  async execute(args: string[]): Promise<ExecResult> {
    this.calls.push(args.join(" "));
    if (this.error) {
      throw this.error;
    }
    return { stdout: "", stderr: "", toString: () => "", trim: () => "", includes: () => false };
  }

  async isScreenOn(): Promise<boolean> {
    return true;
  }

  async getWakefulness(): Promise<typeof this.wakefulness> {
    this.calls.push("read wakefulness");
    if (this.readError) {
      throw this.readError;
    }
    return this.wakefulness;
  }
}

describe("ambient power state", () => {
  test.each([
    ["enter", "Dozing", true, "KEYCODE_SLEEP"],
    ["enter", "Asleep", true, "KEYCODE_SLEEP"],
    ["enter", "Awake", false, "KEYCODE_SLEEP"],
    ["exit", "Awake", true, "KEYCODE_WAKEUP"],
    ["exit", "Dozing", false, "KEYCODE_WAKEUP"],
  ] satisfies Array<[AmbientAction, NonNullable<FakeAmbientAdb["wakefulness"]>, boolean, string]>)(
    "%s reads %s and reports success=%s",
    async (action, wakefulness, success, key) => {
      const adb = new FakeAmbientAdb();
      adb.wakefulness = wakefulness;
      const result = await new AdbAmbient(adb).change(action);
      expect(adb.calls).toEqual([`shell input keyevent ${key}`, "read wakefulness"]);
      expect(result).toMatchObject({ success, action, wakefulness });
      expect(result.message).toContain("power-state change");
      expect(result.message).toContain("no ambient readback");
      expect(result.message).toContain("does not prove ambient mode");
      if (!success) {
        expect(result.reason).toContain(wakefulness);
      }
    },
  );

  test("unreadable wakefulness is a failure", async () => {
    const adb = new FakeAmbientAdb();
    adb.wakefulness = null;
    const result = await new AdbAmbient(adb).change("enter");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("could not be read");
    expect(result.wakefulness).toBeUndefined();
    expect(adb.calls).toHaveLength(2);
  });

  test.each(["command", "read", "output"])(
    "%s failure becomes ActionableError",
    async (failure) => {
      const adb = new FakeAmbientAdb();
      if (failure === "command") {
        adb.error = new Error("offline");
      }
      if (failure === "read") {
        adb.readError = new Error("offline");
      }
      if (failure === "output") {
        adb.execute = async () => ({
          stdout: "Error: permission denied",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        });
      }
      await expect(new AdbAmbient(adb).change("enter")).rejects.toBeInstanceOf(ActionableError);
    },
  );
});
