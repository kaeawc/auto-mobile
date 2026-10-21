import type { ObserveResult } from "../../../models";
import type { HierarchyLayer } from "../../../models/HierarchyLayer";
import { ActionableError } from "../../../models/ActionableError";
import type { KeyEventPlan } from "../../../utils/android-cmdline-tools/asciiKeyEvents";
import { hasFocusedTextInput } from "../ClearText";
import { focusedImeFieldClass } from "../imeFailureDiagnostics";
import {
  ANDROID_TYPE_FOCUSED_INPUT_ERROR,
  isPrintableAscii,
  segmentGraphemes,
} from "./AndroidTypingConstants";
import type {
  ResolvedSendKeysTypingMode,
  SendKeysObserver,
  SendKeysOperation,
  SendKeysTypingMode,
} from "../SendKeys";

type AndroidSendKeysTypingMode = Exclude<ResolvedSendKeysTypingMode, "xcuiTypeText">;

export interface PasswordRoutingDeps {
  platform(): string;
  observer: Pick<SendKeysObserver, "execute">;
  targetLayer(): HierarchyLayer | undefined;
  resolveMode(requestedMode: SendKeysTypingMode): AndroidSendKeysTypingMode;
  supportsImePasswordCommit(): Promise<boolean>;
  getEventAllKeyEventPlan(grapheme: string): Promise<KeyEventPlan | null>;
  hasFocusedPasswordField(hierarchy: NonNullable<ObserveResult["viewHierarchy"]>): boolean;
}

/**
 * Password-field routing for Auto typing: decides the mode, and verifies that a password insert
 * can be delivered as key events before anything is typed. Moved out of
 * DefaultSendKeysCommandExecutor unchanged (#11840).
 */
export class PasswordRouting {
  constructor(private readonly deps: PasswordRoutingDeps) {}

  async resolveAutoPasswordMode(
    requestedMode: SendKeysTypingMode,
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ): Promise<{
    mode: AndroidSendKeysTypingMode;
    focusedInputVerified: boolean;
    verifyPasswordDeliverable: boolean;
    focusedFieldClass?: string | null;
    passwordField?: boolean;
  }> {
    if (this.deps.platform() !== "android" || requestedMode !== "auto") {
      return {
        mode: this.deps.resolveMode(requestedMode),
        focusedInputVerified: false,
        verifyPasswordDeliverable: false,
      };
    }
    let focusedFieldClass: string | null = null;
    const password = await this.isFocusedAndroidPasswordField(
      operation,
      signal,
      display,
      (observation) => {
        focusedFieldClass = focusedImeFieldClass(observation);
      },
    );
    const focusedInputVerified = password !== undefined;
    if (password && (await this.deps.supportsImePasswordCommit())) {
      // The CtrlProxy IME commits and clears password fields like any other field.
      return {
        mode: "ime",
        focusedInputVerified,
        verifyPasswordDeliverable: false,
        focusedFieldClass,
        passwordField: true,
      };
    }
    return {
      mode: password ? (operation === "insert" ? "eventAll" : "a11y") : "ime",
      focusedInputVerified,
      verifyPasswordDeliverable: password === true && operation === "insert",
      focusedFieldClass,
      ...(password ? { passwordField: true } : {}),
    };
  }

  async verifyPasswordRouting(
    routing: { verifyPasswordDeliverable: boolean },
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (routing.verifyPasswordDeliverable) {
      await this.requirePasswordTextDeliverable(text, signal);
    }
  }

  /**
   * Auto insert into a password field is delivered as key events, because CtrlProxy refuses
   * `request_insert_text` on password fields. A character with no key event (non-ASCII, or an
   * uppercase letter / shifted symbol below API 31) would be refused mid-run after the earlier
   * characters were already typed (#9941). Decide up front so nothing is typed in that case.
   */
  async requirePasswordTextDeliverable(text: string, signal?: AbortSignal): Promise<void> {
    const undeliverable: string[] = [];
    for (const grapheme of segmentGraphemes(text)) {
      signal?.throwIfAborted();
      if (!(await this.deps.getEventAllKeyEventPlan(grapheme))) {
        undeliverable.push(grapheme);
      }
    }
    if (undeliverable.length === 0) {
      return;
    }
    // Never name the characters: they are part of a password.
    const nonAscii = undeliverable.filter((grapheme) => !isPrintableAscii(grapheme)).length;
    const reasons = [
      ...(nonAscii > 0 ? [`${nonAscii} non-ASCII (no key event exists)`] : []),
      ...(undeliverable.length > nonAscii
        ? [
            `${undeliverable.length - nonAscii} uppercase or shifted (key events need Android 12, API 31, or newer)`,
          ]
        : []),
    ];
    throw new ActionableError(
      `Nothing was typed: the text for the focused password field contains ${undeliverable.length} character(s) that cannot be sent as key events on this device (${reasons.join("; ")}), and Android password fields refuse text insertion, so typing would leave part of the password entered. Use operation: "replace" to set the whole value at once.`,
    );
  }

  async isFocusedAndroidPasswordField(
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
    onObservation?: (observation: ObserveResult) => void,
  ): Promise<boolean | undefined> {
    const observation = await this.deps.observer.execute({
      signal,
      freshness: "fresh",
      skipScreenshot: true,
      ...(display === undefined ? {} : { display }),
    });
    onObservation?.(observation);
    const hierarchy = observation.viewHierarchy;
    if (!hierarchy || !hasFocusedTextInput(hierarchy)) {
      // Auto insert already reads focus for password routing. Reject before dispatch
      // rather than trusting an IME acknowledgement with no readable editable target.
      if (operation === "insert" && this.deps.targetLayer() !== "prototype") {
        throw new ActionableError(ANDROID_TYPE_FOCUSED_INPUT_ERROR);
      }
      // Replace still dispatches; distinguish absent focus from a focused non-password field.
      return undefined;
    }
    return this.deps.hasFocusedPasswordField(hierarchy);
  }
}
