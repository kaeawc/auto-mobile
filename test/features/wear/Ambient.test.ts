import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AdbAmbient,
  type AmbientAdb,
  type AmbientAction,
} from "../../../src/features/wear/Ambient";
import { ActionableError, type ExecResult } from "../../../src/models";

type Wakefulness = "Awake" | "Asleep" | "Dozing";

// Whole raw dumpsys wear_service captures from a Wear OS 7.0 / API 37 emulator.
const AMBIENT_CAPTURE = readFileSync(
  join(import.meta.dir, "../../fixtures/wear/wear-service/ambient-after-sleep.txt"),
  "utf8",
);
const INTERACTIVE_CAPTURE = readFileSync(
  join(import.meta.dir, "../../fixtures/wear/wear-service/interactive-watch-face.txt"),
  "utf8",
);
const SETTINGS_CAPTURE = readFileSync(
  join(import.meta.dir, "../../fixtures/wear/wear-service/interactive-settings-front.txt"),
  "utf8",
);

const output = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (text: string) => stdout.includes(text),
});

class FakeAmbientAdb implements AmbientAdb {
  readonly calls: string[] = [];
  wakefulness: Wakefulness | null = "Dozing";
  wearService = AMBIENT_CAPTURE;
  error?: Error;
  readError?: Error;
  wearServiceError?: Error;

  async execute(args: string[]): Promise<ExecResult> {
    this.calls.push(args.join(" "));
    if (args.includes("wear_service")) {
      if (this.wearServiceError) {
        throw this.wearServiceError;
      }
      return output(this.wearService);
    }
    if (this.error) {
      throw this.error;
    }
    return output("");
  }

  async isScreenOn(): Promise<boolean> {
    return true;
  }

  async getWakefulness(): Promise<Wakefulness | null> {
    this.calls.push("read wakefulness");
    if (this.readError) {
      throw this.readError;
    }
    return this.wakefulness;
  }
}

const KEY: Record<AmbientAction, string> = { enter: "KEYCODE_SLEEP", exit: "KEYCODE_WAKEUP" };

async function run(action: AmbientAction, wakefulness: Wakefulness | null, wearService: string) {
  const adb = new FakeAmbientAdb();
  adb.wakefulness = wakefulness;
  adb.wearService = wearService;
  const result = await new AdbAmbient(adb).change(action);
  expect(adb.calls).toEqual([
    `shell input keyevent ${KEY[action]}`,
    "read wakefulness",
    "shell dumpsys wear_service",
  ]);
  return result;
}

describe("ambient readback from dumpsys wear_service", () => {
  test("enter: captured inAmbient=true dump succeeds and reports ambient", async () => {
    const result = await run("enter", "Dozing", AMBIENT_CAPTURE);
    expect(result).toMatchObject({
      success: true,
      action: "enter",
      ambient: true,
      watchFaceVisible: true,
      wakefulness: "Dozing",
    });
    expect(result.reason).toBeUndefined();
    expect(result.message).toContain("inAmbient=true");
    expect(result.message).not.toContain("no ambient readback");
  });

  test("exit: captured inAmbient=false dump with Awake succeeds", async () => {
    const result = await run("exit", "Awake", INTERACTIVE_CAPTURE);
    expect(result).toMatchObject({ success: true, ambient: false, wakefulness: "Awake" });
  });

  test("enter: Dozing wakefulness without inAmbient=true is a failure", async () => {
    const result = await run("enter", "Dozing", INTERACTIVE_CAPTURE);
    expect(result).toMatchObject({ success: false, ambient: false });
    expect(result.reason).toContain("inAmbient=false");
  });

  test("enter: Settings in front reports the face is not on screen", async () => {
    const result = await run("enter", "Dozing", SETTINGS_CAPTURE);
    expect(result).toMatchObject({ success: false, ambient: false, watchFaceVisible: false });
    expect(result.reason).toContain("watchFaceVisible=false");
  });

  test("enter: display kept awake points at the stay-awake setting", async () => {
    const result = await run("enter", "Awake", INTERACTIVE_CAPTURE);
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Observed wakefulness Awake");
    expect(result.reason).toContain("svc power stayon");
  });

  test("exit: still in ambient is a failure", async () => {
    const result = await run("exit", "Awake", AMBIENT_CAPTURE);
    expect(result).toMatchObject({ success: false, ambient: true });
  });
});

describe("ambient fallback without a watch-face readback", () => {
  test.each([
    ["enter", "Dozing", true],
    ["enter", "Asleep", true],
    ["enter", "Awake", false],
    ["exit", "Awake", true],
    ["exit", "Dozing", false],
  ] satisfies Array<[AmbientAction, Wakefulness, boolean]>)(
    "%s reads %s and reports success=%s with ambient unknown",
    async (action, wakefulness, success) => {
      const result = await run(action, wakefulness, "Can't find service: wear_service");
      expect(result).toMatchObject({ success, action, wakefulness, ambient: "unknown" });
      expect(result.watchFaceVisible).toBeUndefined();
      expect(result.message).toContain("does not prove ambient mode");
      if (!success) {
        expect(result.reason).toContain(wakefulness);
      }
    },
  );

  test("a failed wear_service read falls back to wakefulness", async () => {
    const adb = new FakeAmbientAdb();
    adb.wearServiceError = new Error("offline");
    const result = await new AdbAmbient(adb).change("enter");
    expect(result).toMatchObject({ success: true, ambient: "unknown", wakefulness: "Dozing" });
  });

  test("unreadable wakefulness is a failure", async () => {
    const result = await run("enter", null, "");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("could not be read");
    expect(result.wakefulness).toBeUndefined();
  });

  test("an aborted wear_service read is not swallowed", async () => {
    const controller = new AbortController();
    const adb = new FakeAmbientAdb();
    adb.execute = async (args) => {
      if (args.includes("wear_service")) {
        controller.abort();
        throw new Error("aborted");
      }
      return output("");
    };
    await expect(new AdbAmbient(adb).change("enter", controller.signal)).rejects.toBeInstanceOf(
      ActionableError,
    );
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
        adb.execute = async () => output("Error: permission denied");
      }
      await expect(new AdbAmbient(adb).change("enter")).rejects.toBeInstanceOf(ActionableError);
    },
  );
});
