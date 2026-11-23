import { realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { AMBIENT_ENV, readEnvTrimmed } from "../../config/env";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { runExecSeam } from "../ExecSeam";
import { execFileAsync, type ExecFileAsync } from "../HostCommandExecutor";

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

/**
 * JavaScript for Automation run by `osascript`: it loads the system CoreSimulator framework and
 * calls `-[SimDevice setHardwareKeyboardEnabled:keyboardType:error:]` or
 * `-[SimDevice setKeyboardLanguage:error:]` on the booted device. The error out-parameter is passed
 * as null because the JXA bridge crashes when it boxes the returned NSError. A separate process
 * keeps the private framework out of the daemon.
 */
export const SIMULATOR_KEYBOARD_JXA = `
ObjC.import("Foundation");
function run(argv) {
  const developerDir = argv[0], udid = argv[1], action = argv[2];
  const bundle = $.NSBundle.bundleWithPath("/Library/Developer/PrivateFrameworks/CoreSimulator.framework");
  if (bundle.isNil() || !bundle.load) return JSON.stringify({ error: "private-api-unavailable" });
  const contextClass = $.NSClassFromString("SimServiceContext");
  if (contextClass.isNil()) return JSON.stringify({ error: "private-api-unavailable" });
  const context = contextClass.sharedServiceContextForDeveloperDirError($(developerDir), null);
  if (context.isNil()) return JSON.stringify({ error: "private-api-unavailable" });
  const set = context.defaultDeviceSetWithError(null);
  if (set.isNil()) return JSON.stringify({ error: "private-api-unavailable" });
  const id = $.NSUUID.alloc.initWithUUIDString($(udid));
  const device = id.isNil() ? id : set.devicesByUDID.objectForKey(id);
  if (device.isNil()) return JSON.stringify({ error: "device-not-found" });
  if (Number(device.state) !== 3) return JSON.stringify({ error: "device-not-booted" });
  const ok = action === "hardware"
    ? device.setHardwareKeyboardEnabledKeyboardTypeError(argv[3] === "1", Number(argv[4]), null)
    : device.setKeyboardLanguageError($(argv[3]), null);
  return JSON.stringify({ ok: ok === true });
}
`;

const outputSchema = z.union([
  z.object({ ok: z.boolean() }).strict(),
  z
    .object({ error: z.enum(["private-api-unavailable", "device-not-found", "device-not-booted"]) })
    .strict(),
]);

const CALL_TIMEOUT_MS = 30_000;

/**
 * The active Xcode developer directory, as CoreSimulator wants it: `DEVELOPER_DIR` (an `.app`
 * path means its `Contents/Developer`), else the `xcode-select` link.
 */
export async function resolveDeveloperDirectory(
  env: NodeJS.ProcessEnv = process.env,
  resolve: (target: string) => Promise<string> = realpath,
): Promise<string> {
  const selected = await resolve(
    readEnvTrimmed(AMBIENT_ENV.DEVELOPER_DIR, env) || "/var/db/xcode_select_link",
  );
  return selected.endsWith(".app") ? path.join(selected, "Contents/Developer") : selected;
}

function failureMessage(code: string, udid: string): string {
  switch (code) {
    case "device-not-found":
      return `Simulator ${udid} is not in the default CoreSimulator device set.`;
    case "device-not-booted":
      return `Simulator ${udid} is not booted; boot it before changing its keyboard.`;
    default:
      return "CoreSimulator's SimDevice keyboard API is unavailable; check that DEVELOPER_DIR or xcode-select points at a supported Xcode.";
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch (error) {
    // Unparseable output falls through to the schema failure, which reports the text.
    return { unparseable: String(error) };
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
    const argv = [
      "-l",
      "JavaScript",
      "-e",
      SIMULATOR_KEYBOARD_JXA,
      await this.developerDirectory(),
      udid,
      ...args,
    ];
    let stdout: string;
    try {
      const result = await runExecSeam(
        (execOptions) => this.exec("osascript", argv, execOptions),
        { timeoutMs: CALL_TIMEOUT_MS, ...(options?.signal ? { signal: options.signal } : {}) },
        { command: "osascript", args: ["-l", "JavaScript", "<simulator keyboard>", udid, ...args] },
      );
      stdout = result.stdout;
    } catch (error) {
      throw toActionableError(error, `Simulator keyboard call failed on ${udid}`);
    }
    const parsed = outputSchema.safeParse(parseJson(stdout));
    if (!parsed.success) {
      throw new ActionableError(
        `Simulator keyboard call on ${udid} printed unexpected output: ${stdout.trim().slice(0, 200)}`,
      );
    }
    if ("error" in parsed.data) {
      throw new ActionableError(failureMessage(parsed.data.error, udid));
    }
    return parsed.data.ok;
  }
}
