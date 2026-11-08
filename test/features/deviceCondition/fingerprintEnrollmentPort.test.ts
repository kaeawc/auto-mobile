import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExecResult } from "../../../src/models";
import {
  AdbFingerprintEnrollmentPort,
  parseFingerprintEnrollmentCount,
} from "../../../src/features/deviceCondition/fingerprintEnrollmentPort";
import {
  classifyEnrollmentScreen,
  ENROLL_MAX_UNKNOWN_STREAK,
  FINGERPRINT_ENROLL_ACTION,
  parseEnrollmentScreen,
} from "../../../src/features/deviceCondition/fingerprintSettingsEnrollment";
import type {
  AndroidDeviceTraits,
  DeviceTraits,
} from "../../../src/utils/android-cmdline-tools/deviceTraits";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const node = (attributes: Record<string, string>) =>
  `<node ${Object.entries(attributes)
    .map(([name, value]) => `${name}="${value}"`)
    .join(" ")} />`;

const screen = (...nodes: string[]) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${nodes.join("")}</hierarchy>`;

const SCREENS = {
  credential: screen(
    node({ text: "Re-enter your PIN", "resource-id": "", bounds: "[0,0][100,50]" }),
    node({
      text: "",
      "resource-id": "com.android.settings:id/password_entry",
      bounds: "[0,100][1000,200]",
    }),
  ),
  consentMore: screen(
    node({ text: "Unlock with fingerprint", bounds: "[0,0][100,50]" }),
    node({ text: "No thanks", bounds: "[0,900][400,1000]" }),
    node({ text: "More", bounds: "[600,900][1000,1000]" }),
  ),
  consentAgree: screen(
    node({ text: "No thanks", bounds: "[0,900][400,1000]" }),
    node({ text: "I agree", bounds: "[600,900][1000,1000]" }),
  ),
  touch: screen(
    node({ text: "Touch the sensor", bounds: "[0,0][100,50]" }),
    node({ text: "Skip", bounds: "[0,900][400,1000]" }),
  ),
  unknown: screen(node({ text: "Bienvenue", bounds: "[0,0][100,50]" })),
  launcher: screen(node({ text: "Phone", bounds: "[0,0][100,50]" })),
};

const ENROLL_FLOW = ["credential", "consentMore", "consentAgree", "touch"];

/** `am start` output when Settings' finished enroll task is still alive (#17380, mt0091c). */
const BROUGHT_TO_FRONT = readFileSync(
  path.join(
    import.meta.dir,
    "../../fixtures/android-fingerprint-enroll/am-start-stale-task-brought-to-front.txt",
  ),
  "utf8",
);

const dumpsys = (count: number) =>
  `Fingerprint Manager\n{"service":"Fingerprint Manager","isUdfps":false,"prints":[{"id":0,"count":${count},"accept":0}]}\nHAL deaths since last reboot: 0`;

/**
 * An emulator in Settings' enrollment flow: three sensor touches enroll one fingerprint. Like
 * Settings, a finished enroll task survives HOME, so a later plain `am start` only brings it to
 * the front over the launcher; `am start -S` force-stops Settings and starts the flow afresh.
 */
class EnrollingEmulator extends FakeAdbExecutor {
  /** Screens a fresh enroll task walks through. */
  flow: string[] = [...ENROLL_FLOW];
  screens: string[] = ["launcher"];
  settingsTaskAlive = false;
  count = 0;
  touches = 0;
  readonly commands: string[] = [];
  console = "Android console commands:\n    finger    manage emulator fingerprint\nOK";

  override async execute(args: string[]): Promise<ExecResult> {
    const command = args.join(" ");
    this.commands.push(command);
    if (command === "emu help") {
      return this.result(this.console);
    }
    if (command.startsWith("emu finger touch")) {
      this.touches += 1;
      if (this.touches % 3 === 0) {
        this.count += 1;
      }
      return this.result("OK");
    }
    if (command === "shell dumpsys fingerprint") {
      return this.result(dumpsys(this.count));
    }
    if (command.startsWith("shell am start")) {
      return this.startEnroll(command.split(" ").includes("-S"));
    }
    if (command === "shell input keyevent KEYCODE_HOME") {
      this.screens = ["launcher"];
      return this.result("");
    }
    if (command.startsWith("shell cat")) {
      const current = (this.screens[0] ?? "launcher") as keyof typeof SCREENS;
      return this.result(SCREENS[current]);
    }
    if (command.startsWith("shell input text") || command.startsWith("shell input tap")) {
      this.screens.shift();
    }
    return this.result("");
  }

  createResult(stdout: string): ExecResult {
    return this.createExecResult(stdout, "");
  }

  private startEnroll(forceStop: boolean): ExecResult {
    if (this.settingsTaskAlive && !forceStop) {
      return this.result(BROUGHT_TO_FRONT);
    }
    this.settingsTaskAlive = true;
    this.screens = [...this.flow];
    return this.result(`Starting: Intent { act=${FINGERPRINT_ENROLL_ACTION} }\nStatus: ok`);
  }

  private result(stdout: string): ExecResult {
    return this.createResult(stdout);
  }
}

const emulatorTraits = (isEmulator: boolean | null): DeviceTraits => ({
  read: async (): Promise<AndroidDeviceTraits> => ({
    isEmulator,
    model: null,
    sdk: null,
    abi: null,
    manufacturer: null,
    brand: null,
    skin: null,
    formFactor: null,
  }),
});

const portFor = (adb: EnrollingEmulator, isEmulator: boolean | null = true) => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return new AdbFingerprintEnrollmentPort(adb, "emulator-5554", {
    timer,
    traits: emulatorTraits(isEmulator),
  });
};

describe("parseFingerprintEnrollmentCount", () => {
  test("reads the user's count from the JSON line", () => {
    expect(parseFingerprintEnrollmentCount(dumpsys(2))).toBe(2);
  });

  test("is undefined without a sensor reporting the user", () => {
    expect(parseFingerprintEnrollmentCount("Fingerprint Manager\nno sensors")).toBeUndefined();
    expect(parseFingerprintEnrollmentCount(dumpsys(1), 10)).toBeUndefined();
    expect(parseFingerprintEnrollmentCount('{"prints": broken')).toBeUndefined();
  });
});

describe("classifyEnrollmentScreen", () => {
  test("recognizes the credential, touch and advance screens", async () => {
    expect(classifyEnrollmentScreen(await parseEnrollmentScreen(SCREENS.credential))).toEqual({
      kind: "credential",
    });
    expect(classifyEnrollmentScreen(await parseEnrollmentScreen(SCREENS.touch))).toEqual({
      kind: "touch-sensor",
    });
    expect(classifyEnrollmentScreen(await parseEnrollmentScreen(SCREENS.consentAgree))).toEqual({
      kind: "advance",
      label: "I agree",
      tap: { x: 800, y: 950 },
    });
  });

  test("names the text of an unrecognized screen, and reads a non-XML dump as empty", async () => {
    expect(classifyEnrollmentScreen(await parseEnrollmentScreen(SCREENS.unknown))).toEqual({
      kind: "unknown",
      summary: "Bienvenue",
    });
    expect(await parseEnrollmentScreen("ERROR: could not get idle state.")).toEqual([]);
  });
});

describe("AdbFingerprintEnrollmentPort", () => {
  test("enrolls through Settings: PIN, consent, then sensor touches until the count rises", async () => {
    const adb = new EnrollingEmulator();

    await portFor(adb).enrollFingerprint(1, 1);

    expect(adb.count).toBe(1);
    expect(adb.commands[0]).toBe(`shell am start -S -W -a ${FINGERPRINT_ENROLL_ACTION}`);
    expect(adb.commands).toContain("shell input text 1234");
    expect(adb.commands.filter((command) => command === "emu finger touch 1")).toHaveLength(3);
    expect(adb.commands).toContain("emu finger remove");
    expect(adb.commands.at(-1)).toBe("shell input keyevent KEYCODE_HOME");
  });

  test("a second add reaches the enroll screen although the first run's Settings task is alive", async () => {
    const adb = new EnrollingEmulator();
    const port = portFor(adb);

    await port.enrollFingerprint(1, 1);
    await port.enrollFingerprint(2, 2);

    expect(adb.count).toBe(2);
    expect(adb.commands.filter((command) => command === "emu finger touch 2")).toHaveLength(3);
  });

  test("refuses at once when Settings brings a stale task to the front", async () => {
    const adb = new EnrollingEmulator();
    adb.settingsTaskAlive = true;
    const start = adb.execute.bind(adb);
    adb.execute = async (args) =>
      args.join(" ").startsWith("shell am start")
        ? adb.createResult(BROUGHT_TO_FRONT)
        : start(args);

    await expect(portFor(adb).enrollFingerprint(1, 1)).rejects.toThrow(/brought .* to the front/);
    expect(adb.commands.some((command) => command.startsWith("shell uiautomator"))).toBe(false);
  });

  test("stops on an unrecognized screen, naming its text", async () => {
    const adb = new EnrollingEmulator();
    adb.flow = Array.from({ length: ENROLL_MAX_UNKNOWN_STREAK }, () => "unknown");

    await expect(portFor(adb).enrollFingerprint(1, 1)).rejects.toThrow(/Bienvenue/);
  });

  test("fails when Settings keeps rejecting the PIN", async () => {
    const adb = new EnrollingEmulator();
    adb.execute = async (args) => {
      const command = args.join(" ");
      if (command === "shell dumpsys fingerprint") {
        return adb.createResult(dumpsys(0));
      }
      return adb.createResult(command.startsWith("shell cat") ? SCREENS.credential : "");
    };

    await expect(portFor(adb).enrollFingerprint(1, 1)).rejects.toThrow(/PIN was not accepted/);
  });

  test("detects the emulator and its console", async () => {
    const adb = new EnrollingEmulator();
    expect(await portFor(adb).isEmulator()).toBe(true);
    expect(await portFor(adb, null).isEmulator()).toBe(false);
    expect(await portFor(adb).consoleSupportsFinger()).toBe(true);

    adb.console = "KO: unknown command";
    expect(await portFor(adb).consoleSupportsFinger()).toBe(false);
  });

  test("an unreadable dumpsys refuses with the reason", async () => {
    const adb = new EnrollingEmulator();
    adb.execute = async () => adb.createResult("no fingerprint service");
    await expect(portFor(adb).enrolledCount()).rejects.toThrow(/no fingerprint sensor/);
  });
});
