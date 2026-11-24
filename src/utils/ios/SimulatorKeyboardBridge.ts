import { z } from "zod/v4";
import { ActionableError } from "../../models/ActionableError";
import { execFileAsync, type ExecFileAsync } from "../HostCommandExecutor";
import {
  coreSimulatorJxaScript,
  resolveDeveloperDirectory,
  runCoreSimulatorJxa,
  type CoreSimulatorJxaFailure,
} from "../ios-cmdline-tools/CoreSimulatorJxa";

/**
 * Physical layout of the simulated hardware keyboard. CoreSimulator takes the Apple USB keyboard
 * type code: Simulator.app passes `IndigoHIDGetKeyboardType()`, which maps the host's
 * `CGEventSourceGetKeyboardType` to 204 (ANSI), 205 (ISO) or 206 (JIS).
 */
export const HARDWARE_KEYBOARD_LAYOUTS = ["ansi", "iso", "jis"] as const;
export type HardwareKeyboardLayout = (typeof HARDWARE_KEYBOARD_LAYOUTS)[number];

export const HARDWARE_KEYBOARD_TYPE_CODES: Readonly<Record<HardwareKeyboardLayout, number>> = {
  ansi: 204,
  iso: 205,
  jis: 206,
};

/** Every simulator boot connects the hardware keyboard; a reset puts this state back. */
export const BOOT_HARDWARE_KEYBOARD = { connected: true, layout: "ansi" } as const;

/**
 * A keyboard input mode identifier as iOS stores it before the `@` (`en_US`, `fr`, `ja_JP-Kana`,
 * `zh_Hans-Pinyin`). CoreSimulator answers NO for an identifier it does not know.
 */
export const KEYBOARD_LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})*$/;

export interface SimulatorKeyboardCallOptions {
  signal?: AbortSignal;
}

/** The two CoreSimulator `SimDevice` keyboard calls (#19017). */
export interface SimulatorKeyboardBridge {
  setHardwareKeyboard(
    udid: string,
    connected: boolean,
    layout: HardwareKeyboardLayout,
    options?: SimulatorKeyboardCallOptions,
  ): Promise<void>;
  setKeyboardLanguage(
    udid: string,
    language: string,
    options?: SimulatorKeyboardCallOptions,
  ): Promise<void>;
}

/** Runs after the shared CoreSimulator prelude: argv[2] is the action, then its arguments. */
const KEYBOARD_BODY = `
  const ok = argv[2] === "hardware"
    ? device.setHardwareKeyboardEnabledKeyboardTypeError(argv[3] === "1", Number(argv[4]), null)
    : device.setKeyboardLanguageError($(argv[3]), null);
  return JSON.stringify({ ok: ok === true });
`;

/**
 * The `osascript` script that calls `-[SimDevice setHardwareKeyboardEnabled:keyboardType:error:]`
 * or `-[SimDevice setKeyboardLanguage:error:]` on the booted device.
 */
export const SIMULATOR_KEYBOARD_JXA = coreSimulatorJxaScript(KEYBOARD_BODY, true);

const resultSchema = z.object({ ok: z.boolean() }).strict();

const CALL_TIMEOUT_MS = 30_000;

function failureMessage(code: CoreSimulatorJxaFailure, udid: string): string {
  switch (code) {
    case "device-not-found":
      return `Simulator ${udid} is not in the default CoreSimulator device set.`;
    case "device-not-booted":
      return `Simulator ${udid} is not booted; boot it before changing its keyboard.`;
    default:
      return "CoreSimulator's SimDevice keyboard API is unavailable; check that DEVELOPER_DIR or xcode-select points at a supported Xcode.";
  }
}

export class OsascriptSimulatorKeyboardBridge implements SimulatorKeyboardBridge {
  constructor(
    private readonly exec: ExecFileAsync = execFileAsync,
    private readonly developerDirectory: () => Promise<string> = () => resolveDeveloperDirectory(),
  ) {}

  async setHardwareKeyboard(
    udid: string,
    connected: boolean,
    layout: HardwareKeyboardLayout,
    options?: SimulatorKeyboardCallOptions,
  ): Promise<void> {
    const ok = await this.call(
      udid,
      ["hardware", connected ? "1" : "0", String(HARDWARE_KEYBOARD_TYPE_CODES[layout])],
      options,
    );
    if (!ok) {
      throw new ActionableError(
        `CoreSimulator refused to ${connected ? "connect" : "disconnect"} the hardware keyboard on ${udid}.`,
      );
    }
  }

  async setKeyboardLanguage(
    udid: string,
    language: string,
    options?: SimulatorKeyboardCallOptions,
  ): Promise<void> {
    if (!KEYBOARD_LANGUAGE_PATTERN.test(language)) {
      throw new ActionableError(
        `Keyboard language "${language}" is not a keyboard identifier such as en_US, fr or ja_JP-Kana.`,
      );
    }
    const ok = await this.call(udid, ["language", language], options);
    if (!ok) {
      throw new ActionableError(
        `CoreSimulator has no keyboard for language "${language}" on ${udid}; use an identifier such as en_US, fr_FR or ja_JP.`,
      );
    }
  }

  private async call(
    udid: string,
    args: string[],
    options?: SimulatorKeyboardCallOptions,
  ): Promise<boolean> {
    const result = await runCoreSimulatorJxa(
      {
        udid,
        body: KEYBOARD_BODY,
        args,
        requireBooted: true,
        timeoutMs: CALL_TIMEOUT_MS,
        ...(options?.signal ? { signal: options.signal } : {}),
        resultSchema,
        label: "keyboard",
        scriptPlaceholder: "<simulator keyboard>",
        describeFailure: (code) => failureMessage(code, udid),
      },
      { exec: this.exec, developerDirectory: this.developerDirectory },
    );
    return result.ok;
  }
}
