import { z } from "zod/v4";
import { BOOT_HARDWARE_KEYBOARD } from "../../../utils/ios/SimulatorKeyboardBridge";
import type { DeviceMutationInput, MutationValue } from "./types";

/** Journal key of an iOS Simulator hardware keyboard connect or disconnect (#19017). */
export const SIMULATOR_HARDWARE_KEYBOARD_KEY = "hardware";
/** Journal key of an iOS Simulator keyboard language change (#19017). */
export const SIMULATOR_KEYBOARD_LANGUAGE_KEY = "language";

const hardwarePriorSchema = z
  .object({ connected: z.boolean(), layout: z.enum(["ansi", "iso", "jis"]) })
  .strict();

/**
 * What a keyboard language change rewrites: the enabled keyboards (`AppleKeyboards`), the
 * preferred languages it appends to (`AppleLanguages`), and the selected keyboard
 * (`com.apple.keyboard.preferences` `KeyboardLastUsed`), each null when unset (a new simulator has
 * neither `AppleKeyboards` nor `KeyboardLastUsed`). `locale` (`AppleLocale`) names the keyboard
 * to select when no language keyboard is recorded.
 */
const languagePriorSchema = z
  .object({
    keyboards: z.array(z.string().min(1)).min(1).nullable(),
    languages: z.array(z.string().min(1)).min(1).nullable(),
    current: z.string().min(1).nullable(),
    locale: z.string().min(1).nullable(),
  })
  .strict();

export type SimulatorKeyboardLanguagePrior = z.infer<typeof languagePriorSchema>;

/**
 * CoreSimulator has no read-back for the hardware keyboard, and every boot connects it, so the
 * prior is the boot state.
 */
export function simulatorHardwareKeyboardPrior(): MutationValue {
  return { state: "present", value: { ...BOOT_HARDWARE_KEYBOARD } };
}

export function simulatorKeyboardLanguagePrior(
  prior: SimulatorKeyboardLanguagePrior,
): MutationValue {
  return { state: "present", value: prior };
}

export type SimulatorKeyboardRevert =
  | { kind: "hardware"; connected: boolean; layout: "ansi" | "iso" | "jis" }
  | { kind: "language"; prior: SimulatorKeyboardLanguagePrior; language: string };

/**
 * The input mode identifier `setKeyboardLanguage:` selects for a stored keyboard such as
 * `ja_JP-Kana@sw=Kana;hw=Automatic` (the part before `@`).
 */
export function keyboardLanguageOf(keyboard: string): string {
  return keyboard.split("@")[0]!;
}

/** The revert a `keyboard` journal row asks for, or undefined when it cannot be restored. */
export function simulatorKeyboardRevert(
  mutation: Pick<DeviceMutationInput, "kind" | "key" | "priorValue">,
): SimulatorKeyboardRevert | undefined {
  if (mutation.kind !== "keyboard" || mutation.priorValue.state !== "present") {
    return undefined;
  }
  const value = mutation.priorValue.value;
  if (mutation.key === SIMULATOR_HARDWARE_KEYBOARD_KEY) {
    const parsed = hardwarePriorSchema.safeParse(value);
    return parsed.success ? { kind: "hardware", ...parsed.data } : undefined;
  }
  if (mutation.key === SIMULATOR_KEYBOARD_LANGUAGE_KEY) {
    const parsed = languagePriorSchema.safeParse(value);
    if (!parsed.success) {
      return undefined;
    }
    // The emoji keyboard is not a language; select the first language keyboard, else the locale.
    const selected = [parsed.data.current, ...(parsed.data.keyboards ?? []), parsed.data.locale]
      .filter((keyboard): keyboard is string => !!keyboard)
      .map(keyboardLanguageOf)
      .find((language) => language !== "emoji");
    return selected ? { kind: "language", prior: parsed.data, language: selected } : undefined;
  }
  return undefined;
}
