import { BaseVisualChange } from "./BaseVisualChange";
import { BootedDevice, ImeAction, SendTextResult } from "../../models";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { defaultTimer } from "../../utils/SystemTimer";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";

export type InputTextMode = "a11y" | "eventLast" | "eventAll";

interface KeyEventPlan {
  commands: string[];
}

const ANDROID_KEYCOMBINATION_MIN_API_LEVEL = 31;

export class InputText extends BaseVisualChange {
  private androidInputKeyCombinationSupported: boolean | undefined;

  constructor(device: BootedDevice, adbFactoryOrExecutor: AdbClientFactory | AdbExecutor | null = null) {
    super(device, adbFactoryOrExecutor);
    this.device = device;
  }

  async execute(
    text: string,
    imeAction?: ImeAction,
    dismissKeyboard: boolean = false,
    mode: InputTextMode = "a11y"
  ): Promise<SendTextResult & { method?: InputTextMode }> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("inputText");

    // Validate text input
    if (text === undefined || text === null) {
      perf.end();
      return {
        success: false,
        text: "",
        error: "No text provided",
        method: "a11y"
      };
    }

    return this.observedInteraction(
      async () => {
        try {
          // Platform-specific text input execution
          switch (this.device.platform) {
            case "android":
              return await perf.track("androidTextInput", () =>
                this.executeAndroidTextInput(text, imeAction, dismissKeyboard, mode)
              );
            case "ios":
              // dismissKeyboard is Android-only — it works around an emulator
              // bug where the soft keyboard stays visible after setText.
              return await perf.track("iOSTextInput", () =>
                this.executeiOSTextInput(text, imeAction)
              );
            default:
              perf.end();
              throw new Error(`Unsupported platform: ${this.device.platform}`);
          }
        } catch (error) {
          perf.end();
          const errorMessage = error instanceof Error ? error.message : String(error);

          return {
            success: false,
            text,
            error: `Failed to send text input: ${errorMessage}`,
            method: this.device.platform === "android" ? mode : "a11y"
          };
        }
      },
      {
        changeExpected: true,
        tolerancePercent: 0.00,
        timeoutMs: 5000,
        perf,
        skipUiStability: true // Skip UI stability wait - a11y service already waits 100ms for tree update
      }
    );
  }

  /**
   * Execute Android-specific text input using accessibility service
   * @param text - Text to input
   * @param imeAction - Optional IME action
   * @returns Result with method information
   */
  private async executeAndroidTextInput(
    text: string,
    imeAction?: ImeAction,
    dismissKeyboard: boolean = false,
    mode: InputTextMode = "a11y"
  ): Promise<SendTextResult & { method?: InputTextMode }> {
    if (mode === "eventLast") {
      return this.executeAndroidEventLastTextInput(text, imeAction, dismissKeyboard);
    }

    if (mode === "eventAll") {
      return this.executeAndroidEventAllTextInput(text, imeAction, dismissKeyboard);
    }

    // Use accessibility service exclusively (fastest method, ~10-30ms vs ~200-300ms for ADB)
    // It also natively supports Unicode without needing virtual keyboard
    const a11yClient = AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
    const a11yResult = await a11yClient.requestSetText(text, undefined, undefined, undefined, dismissKeyboard);

    if (a11yResult.success) {
      logger.info(`[InputText] Text input via accessibility service: ${a11yResult.totalTimeMs}ms`);

      // Handle IME action if specified
      if (imeAction) {
        await this.executeImeAction(imeAction);
      }

      return {
        success: true,
        text,
        imeAction,
        method: "a11y"
      };
    }

    // Return failure - no fallback methods
    logger.warn(`[InputText] Accessibility service setText failed: ${a11yResult.error}`);
    return {
      success: false,
      text,
      error: `Accessibility service setText failed: ${a11yResult.error}`,
      method: "a11y"
    };
  }

  private async executeAndroidEventLastTextInput(
    text: string,
    imeAction?: ImeAction,
    dismissKeyboard: boolean = false
  ): Promise<SendTextResult & { method?: InputTextMode }> {
    const split = this.findLastPrintableAsciiNonWhitespace(text);

    if (!split) {
      logger.info("[InputText] eventLast requested but no printable non-whitespace ASCII character was found; using a11y");
      const result = await this.executeAndroidTextInput(text, imeAction, dismissKeyboard, "a11y");
      return { ...result, method: "a11y" };
    }

    const { index, char } = split;
    const prefix = text.slice(0, index);
    const suffix = text.slice(index + 1);
    const keyEventPlan = await this.getAsciiKeyEventPlan(char);
    if (!keyEventPlan) {
      logger.info(`[InputText] eventLast could not map ASCII character ${JSON.stringify(char)} to a key event; using a11y`);
      const result = await this.executeAndroidTextInput(text, imeAction, dismissKeyboard, "a11y");
      return { ...result, method: "a11y" };
    }

    const a11yClient = AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);

    const prefixResult = await a11yClient.requestSetText(prefix, undefined, undefined, undefined, false);
    if (!prefixResult.success) {
      logger.warn(`[InputText] eventLast prefix setText failed: ${prefixResult.error}`);
      return {
        success: false,
        text,
        error: `Accessibility service setText failed before real key event: ${prefixResult.error}`,
        method: "eventLast"
      };
    }

    await this.executeKeyEventPlan(keyEventPlan);

    if (suffix.length > 0 || dismissKeyboard) {
      const finalResult = await a11yClient.requestSetText(text, undefined, undefined, undefined, dismissKeyboard);
      if (!finalResult.success) {
        logger.warn(`[InputText] eventLast final setText failed: ${finalResult.error}`);
        return {
          success: false,
          text,
          error: `Accessibility service setText failed after real key event: ${finalResult.error}`,
          method: "eventLast"
        };
      }
    }

    if (imeAction) {
      await this.executeImeAction(imeAction);
    }

    return {
      success: true,
      text,
      imeAction,
      method: "eventLast"
    };
  }

  private async executeAndroidEventAllTextInput(
    text: string,
    imeAction?: ImeAction,
    dismissKeyboard: boolean = false
  ): Promise<SendTextResult & { method?: InputTextMode }> {
    const chars = Array.from(text);
    if (!await this.hasAsciiKeyEventPlan(chars)) {
      const result = await this.executeAndroidTextInput(text, imeAction, dismissKeyboard, "a11y");
      return { ...result, method: "a11y" };
    }

    const a11yClient = AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
    const clearResult = await a11yClient.requestSetText("", undefined, undefined, undefined, false);
    if (!clearResult.success) {
      logger.warn(`[InputText] eventAll initial clear failed: ${clearResult.error}`);
      return {
        success: false,
        text,
        error: `Accessibility service setText failed before eventAll input: ${clearResult.error}`,
        method: "eventAll"
      };
    }

    let targetText = "";
    for (let index = 0; index < chars.length; index++) {
      const char = chars[index] ?? "";
      const keyEventPlan = await this.getAsciiKeyEventPlan(char);

      if (keyEventPlan) {
        await this.executeKeyEventPlan(keyEventPlan);
        targetText += char;
        continue;
      }

      let unsupportedRun = char;
      while (index + 1 < chars.length && !(await this.getAsciiKeyEventPlan(chars[index + 1] ?? ""))) {
        index++;
        unsupportedRun += chars[index] ?? "";
      }

      targetText += unsupportedRun;
      const setTextResult = await a11yClient.requestSetText(targetText, undefined, undefined, undefined, false);
      if (!setTextResult.success) {
        logger.warn(`[InputText] eventAll setText failed for unsupported text run: ${setTextResult.error}`);
        return {
          success: false,
          text,
          error: `Accessibility service setText failed during eventAll input: ${setTextResult.error}`,
          method: "eventAll"
        };
      }
    }

    if (dismissKeyboard) {
      const finalResult = await a11yClient.requestSetText(text, undefined, undefined, undefined, true);
      if (!finalResult.success) {
        logger.warn(`[InputText] eventAll final setText failed: ${finalResult.error}`);
        return {
          success: false,
          text,
          error: `Accessibility service setText failed after eventAll input: ${finalResult.error}`,
          method: "eventAll"
        };
      }
    }

    if (imeAction) {
      await this.executeImeAction(imeAction);
    }

    return {
      success: true,
      text,
      imeAction,
      method: "eventAll"
    };
  }

  private findLastPrintableAsciiNonWhitespace(text: string): { index: number; char: string } | null {
    for (let index = text.length - 1; index >= 0; index--) {
      const char = text[index];
      if (!char) {
        continue;
      }

      const code = char.charCodeAt(0);
      if (code >= 0x21 && code <= 0x7e && !/\s/.test(char)) {
        return { index, char };
      }
    }

    return null;
  }

  private async hasAsciiKeyEventPlan(chars: string[]): Promise<boolean> {
    for (const char of chars) {
      if (await this.getAsciiKeyEventPlan(char)) {
        return true;
      }
    }

    return false;
  }

  private async getAsciiKeyEventPlan(char: string): Promise<KeyEventPlan | null> {
    if (/^[a-z]$/.test(char)) {
      return {
        commands: [`shell input keyevent KEYCODE_${char.toUpperCase()}`]
      };
    }

    if (/^[A-Z]$/.test(char)) {
      return this.createShiftedKeyEventPlan(`KEYCODE_${char}`);
    }

    if (/^[0-9]$/.test(char)) {
      return {
        commands: [`shell input keyevent KEYCODE_${char}`]
      };
    }

    const directKeyCodes: Record<string, string> = {
      " ": "KEYCODE_SPACE",
      "-": "KEYCODE_MINUS",
      "=": "KEYCODE_EQUALS",
      "[": "KEYCODE_LEFT_BRACKET",
      "]": "KEYCODE_RIGHT_BRACKET",
      "\\": "KEYCODE_BACKSLASH",
      ";": "KEYCODE_SEMICOLON",
      "'": "KEYCODE_APOSTROPHE",
      ",": "KEYCODE_COMMA",
      ".": "KEYCODE_PERIOD",
      "/": "KEYCODE_SLASH",
      "`": "KEYCODE_GRAVE",
      "@": "KEYCODE_AT"
    };

    const shiftedKeyCodes: Record<string, string> = {
      "!": "KEYCODE_1",
      "#": "KEYCODE_3",
      "$": "KEYCODE_4",
      "%": "KEYCODE_5",
      "^": "KEYCODE_6",
      "&": "KEYCODE_7",
      "*": "KEYCODE_8",
      "(": "KEYCODE_9",
      ")": "KEYCODE_0",
      "_": "KEYCODE_MINUS",
      "+": "KEYCODE_EQUALS",
      "{": "KEYCODE_LEFT_BRACKET",
      "}": "KEYCODE_RIGHT_BRACKET",
      "|": "KEYCODE_BACKSLASH",
      ":": "KEYCODE_SEMICOLON",
      "\"": "KEYCODE_APOSTROPHE",
      "<": "KEYCODE_COMMA",
      ">": "KEYCODE_PERIOD",
      "?": "KEYCODE_SLASH",
      "~": "KEYCODE_GRAVE"
    };

    const direct = directKeyCodes[char];
    if (direct) {
      return {
        commands: [`shell input keyevent ${direct}`]
      };
    }

    const shifted = shiftedKeyCodes[char];
    if (shifted) {
      return this.createShiftedKeyEventPlan(shifted);
    }

    return null;
  }

  private async createShiftedKeyEventPlan(baseKeyCode: string): Promise<KeyEventPlan | null> {
    if (await this.supportsAndroidInputKeyCombination()) {
      return {
        commands: [`shell input keycombination KEYCODE_SHIFT_LEFT ${baseKeyCode}`]
      };
    }

    return null;
  }

  private async supportsAndroidInputKeyCombination(): Promise<boolean> {
    if (this.androidInputKeyCombinationSupported !== undefined) {
      return this.androidInputKeyCombinationSupported;
    }

    const apiLevel = await readAndroidDeviceApiLevel(this.adb);
    this.androidInputKeyCombinationSupported =
      apiLevel !== null && apiLevel >= ANDROID_KEYCOMBINATION_MIN_API_LEVEL;
    return this.androidInputKeyCombinationSupported;
  }

  private async executeKeyEventPlan(plan: KeyEventPlan): Promise<void> {
    for (const command of plan.commands) {
      await this.adb.executeCommand(command);
    }
  }

  /**
   * Execute iOS-specific text input
   * @param text - Text to input
   * @param imeAction - Optional IME action
   * @returns Result with method information
   */
  private async executeiOSTextInput(
    text: string,
    imeAction?: ImeAction
  ): Promise<SendTextResult & { method?: "a11y" }> {
    const startMs = Date.now();
    logger.debug(`[InputText] iOS begin textLength=${text.length} imeAction=${imeAction ?? "none"}`);

    const client = IOSCtrlProxyClient.getInstance(this.device);
    const result = await client.requestSetText(text);

    if (!result.success) {
      logger.error(`[InputText] CtrlProxy iOS setText failed: ${result.error} totalMs=${Date.now() - startMs}`);
      return {
        success: false,
        text,
        error: result.error,
        method: "a11y"
      };
    }

    logger.debug(`[InputText] iOS setText ok totalMs=${Date.now() - startMs}`);

    // Handle IME action if specified (CtrlProxy iOS supports this)
    if (imeAction) {
      const imeResult = await client.requestImeAction(imeAction);
      if (!imeResult.success) {
        logger.warn(`[InputText] CtrlProxy iOS IME action failed: ${imeResult.error}`);
      }
    }

    return {
      success: true,
      text,
      imeAction,
      method: "a11y"
    };
  }

  private async executeImeAction(imeAction: string): Promise<void> {
    // Map IME actions to Android key codes
    const imeKeyCodeMap: { [key: string]: string } = {
      "done": "KEYCODE_ENTER",
      "next": "KEYCODE_TAB",
      "search": "KEYCODE_SEARCH",
      "send": "KEYCODE_ENTER",
      "go": "KEYCODE_ENTER",
      "previous": "KEYCODE_SHIFT_LEFT KEYCODE_TAB" // Shift+Tab for previous
    };

    const keyCode = imeKeyCodeMap[imeAction];
    if (keyCode) {
      // Small delay to ensure text input is processed
      await defaultTimer.sleep(100);

      // Execute the key event(s)
      if (keyCode.includes(" ")) {
        // Handle multiple key combinations like Shift+Tab
        const keys = keyCode.split(" ");
        for (const key of keys) {
          await this.adb.executeCommand(`shell input keyevent ${key}`);
        }
      } else {
        await this.adb.executeCommand(`shell input keyevent ${keyCode}`);
      }
    }
  }
}
