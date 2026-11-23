import { z } from "zod/v4";
import type { BootedDevice } from "../../../models";
import { errorMessage } from "../../../utils/describeUnknownError";
import {
  HARDWARE_KEYBOARD_LAYOUTS,
  KEYBOARD_LANGUAGE_PATTERN,
  OsascriptSimulatorKeyboardBridge,
  type HardwareKeyboardLayout,
  type SimulatorKeyboardBridge,
} from "../../../utils/ios/SimulatorKeyboardBridge";
import { isIosSimulatorDevice } from "../../action/IosSimulatorPermissions";

export const keyboardStateInputSchema = z
  .object({
    hardwareKeyboard: z
      .boolean()
      .optional()
      .describe(
        "Connect (true) or disconnect (false) the simulated hardware keyboard. Disconnected, a focused text field always shows the software keyboard; connected, iOS hides it after the first hardware key event.",
      ),
    hardwareLayout: z
      .enum(HARDWARE_KEYBOARD_LAYOUTS)
      .optional()
      .describe("Physical layout reported for the hardware keyboard (default ansi)."),
    language: z
      .string()
      .regex(KEYBOARD_LANGUAGE_PATTERN)
      .optional()
      .describe(
        "Keyboard identifier to add and select, such as en_US, fr_FR, de_DE or ja_JP. It also appends the language to AppleLanguages.",
      ),
  })
  .strict()
  .refine((value) => value.hardwareKeyboard !== undefined || value.language !== undefined, {
    message: "keyboard needs hardwareKeyboard or language",
  })
  .refine((value) => value.hardwareLayout === undefined || value.hardwareKeyboard !== undefined, {
    message: "hardwareLayout needs hardwareKeyboard",
  });

export type SetKeyboardStateInput = z.infer<typeof keyboardStateInputSchema>;

export interface KeyboardState {
  supported: boolean;
  hardwareKeyboard?: boolean;
  hardwareLayout?: HardwareKeyboardLayout;
  language?: string;
  method?: "ios_simulator_coresimulator";
  /** Never true: CoreSimulator has no read-back for either setting. */
  verified?: boolean;
  error?: string;
}

export const IOS_KEYBOARD_UNSUPPORTED_ERROR =
  "The hardware keyboard and keyboard language can only be set on an iOS Simulator.";

interface KeyboardOperationsDependencies {
  device: () => BootedDevice;
  bridge?: SimulatorKeyboardBridge;
}

/** `setDeviceState.keyboard` on an iOS Simulator, through CoreSimulator's SimDevice (#19017). */
export class KeyboardOperations {
  private readonly bridge: SimulatorKeyboardBridge;

  constructor(private readonly dependencies: KeyboardOperationsDependencies) {
    this.bridge = dependencies.bridge ?? new OsascriptSimulatorKeyboardBridge();
  }

  async write(input: SetKeyboardStateInput, signal?: AbortSignal): Promise<KeyboardState> {
    const device = this.dependencies.device();
    if (device.platform !== "ios" || !isIosSimulatorDevice(device)) {
      return { supported: false, error: IOS_KEYBOARD_UNSUPPORTED_ERROR };
    }
    const state: KeyboardState = { supported: true, method: "ios_simulator_coresimulator" };
    try {
      if (input.hardwareKeyboard !== undefined) {
        const layout = input.hardwareLayout ?? "ansi";
        await this.bridge.setHardwareKeyboard(device.deviceId, input.hardwareKeyboard, layout, {
          signal,
        });
        state.hardwareKeyboard = input.hardwareKeyboard;
        state.hardwareLayout = layout;
      }
      if (input.language !== undefined) {
        await this.bridge.setKeyboardLanguage(device.deviceId, input.language, { signal });
        state.language = input.language;
      }
      return state;
    } catch (error) {
      return { ...state, error: errorMessage(error) };
    }
  }
}
