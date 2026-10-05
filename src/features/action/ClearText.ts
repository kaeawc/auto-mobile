import { toActionableError, unsupportedPlatformError } from "../../models/ActionableError";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { ANDROID_KEYCOMBINATION_MIN_API_LEVEL } from "../../utils/android-cmdline-tools/asciiKeyEvents";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import {
  BootedDevice,
  ClearTextResult,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../models";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { DefaultElementParser } from "../utility/ElementParser";
import { ObserveResult } from "../../models";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { toSearchable } from "../utility/SearchableNode";
import { ANDROID_INPUT_CLASSES, isTruthyFlag } from "../utility/elementProperties";

export const DEVICE_TIMESTAMP_SECOND_GRANULARITY_MARGIN_MS = 1000;
export const DELETE_KEYEVENT_CHUNK_SIZE = 50;

function extractSearchRootGroups(
  viewHierarchy: ViewHierarchyResult,
  parser: ElementParser,
): ViewHierarchyNode[][] {
  const windowGroups = parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
  const primaryRoots = parser.extractRootNodes(viewHierarchy);
  const seenRoots = new Set<ViewHierarchyNode>();
  const uniqueRoots = (roots: ViewHierarchyNode[]) =>
    roots.filter((root) => {
      if (seenRoots.has(root)) {
        return false;
      }
      seenRoots.add(root);
      return true;
    });

  return [...windowGroups, primaryRoots].map(uniqueRoots).filter((roots) => roots.length > 0);
}

function getEditableTextLength(
  properties: Record<string, unknown>,
  includeHintText: boolean,
): number | undefined {
  const searchable = toSearchable(properties);
  const text = searchable.textSources.value ?? searchable.textSources.text;
  const hint = properties["hint-text"];
  const android = ["android.", "androidx."].some((prefix) =>
    searchable.className?.startsWith(prefix),
  );
  // Android hierarchy nodes carry no showing-hint flag. Typed text identical to
  // the hint is indistinguishable and counts as empty for verification/skip-clear.
  // SendKeys includes the raw hint length for deletes so replace cannot under-delete
  // that real text; the existing clear sequence runs before verification and typing.
  if (!includeHintText && android && typeof hint === "string" && hint !== "" && text === hint) {
    return 0;
  }
  const capturedLength = typeof text === "string" ? text.length : searchable.capturedTextLength;
  // CtrlProxy omits empty Android text. Require a focused input and preserved
  // non-password metadata; missing iOS values and classless nodes stay unreadable.
  if (
    capturedLength === undefined &&
    android &&
    isFocusedTextInputProperties(properties) &&
    !isTruthyFlag(properties.password)
  ) {
    return 0;
  }
  return capturedLength;
}

/** Include hint text only when budgeting deletes, rather than checking remaining text. */
export function getFocusedTextLength(
  viewHierarchy: ViewHierarchyResult,
  parser: ElementParser = new DefaultElementParser(),
  includeHintText = false,
): number | undefined {
  for (const rootGroup of extractSearchRootGroups(viewHierarchy, parser)) {
    let textLength: number | undefined;
    for (const rootNode of rootGroup) {
      parser.traverseNode(rootNode, (node: any) => {
        const nodeProperties = parser.extractNodeProperties(node);
        const length = getEditableTextLength(nodeProperties, includeHintText);
        if (
          (nodeProperties.focused === "true" || nodeProperties.focused === true) &&
          length !== undefined
        ) {
          textLength = Math.max(textLength ?? 0, length);
        }
      });
    }
    if (textLength !== undefined) {
      return textLength;
    }
  }

  return undefined;
}

export function hasFocusedTextInput(
  viewHierarchy: ViewHierarchyResult,
  parser: ElementParser = new DefaultElementParser(),
): boolean {
  for (const rootGroup of extractSearchRootGroups(viewHierarchy, parser)) {
    for (const rootNode of rootGroup) {
      let found = false;
      parser.traverseNode(rootNode, (node: any) => {
        if (found) {
          return;
        }

        const nodeProperties = parser.extractNodeProperties(node);
        if (isFocusedTextInputProperties(nodeProperties)) {
          found = true;
        }
      });

      if (found) {
        return true;
      }
    }
  }

  return false;
}

/** Read the editable value, never an iOS field's accessibility label or placeholder. */
export function getFocusedTextValue(
  viewHierarchy: ViewHierarchyResult,
  parser: ElementParser = new DefaultElementParser(),
): string | undefined {
  return getFocusedTextField(viewHierarchy, parser)?.value;
}

export interface FocusedTextField {
  value?: string;
  secure: boolean;
}

/** Preserve security metadata even when a focused field's value is unreadable. */
export function getFocusedTextField(
  viewHierarchy: ViewHierarchyResult,
  parser: ElementParser = new DefaultElementParser(),
): FocusedTextField | undefined {
  for (const rootGroup of extractSearchRootGroups(viewHierarchy, parser)) {
    for (const root of rootGroup) {
      let field: FocusedTextField | undefined;
      parser.traverseNode(root, (node: ViewHierarchyNode) => {
        const properties = parser.extractNodeProperties(node);
        if (field !== undefined || !isFocusedTextInputProperties(properties)) {
          return;
        }
        const searchable = toSearchable(properties);
        // Text sources preserve editable values; captured length distinguishes empty text from absence.
        const value =
          searchable.textSources.value ??
          searchable.textSources.text ??
          (searchable.capturedTextLength === 0 ? "" : undefined);
        const nodeClass = properties.class ?? properties.className;
        const secure =
          properties.password === true ||
          properties.password === "true" ||
          (typeof nodeClass === "string" && nodeClass.includes("SecureTextField"));
        if (value !== undefined || secure) {
          field = { value, secure };
        }
      });
      if (field !== undefined) {
        return field;
      }
    }
  }
  return undefined;
}

function isFocusedTextInputProperties(nodeProperties: Record<string, unknown>): boolean {
  if (nodeProperties.focused !== "true" && nodeProperties.focused !== true) {
    return false;
  }
  const nodeClass = nodeProperties.class ?? nodeProperties.className;
  const hasKnownInputClass =
    typeof nodeClass === "string" &&
    (nodeClass.includes("SecureTextField") ||
      ANDROID_INPUT_CLASSES.some((inputClass) => nodeClass.includes(inputClass)));
  const actions = nodeProperties.actions;
  const exposesTextAction = Array.isArray(actions) && actions.includes("set_text");
  const explicitlyEditable = nodeProperties.editable === "true" || nodeProperties.editable === true;
  return hasKnownInputClass || exposesTextAction || explicitlyEditable;
}

/** Select all and delete on API 31+; older devices retain counted deletes from line end. */
export async function clearTextWithKeyEvents(
  adb: AdbExecutor,
  count: number,
  signal?: AbortSignal,
  onDelete?: () => void,
  supportsKeyCombination = false,
): Promise<void> {
  signal?.throwIfAborted();
  await adb.executeCommand(
    supportsKeyCombination
      ? "shell input keycombination KEYCODE_CTRL_LEFT KEYCODE_A"
      : "shell input keyevent KEYCODE_MOVE_END",
  );
  signal?.throwIfAborted();

  if (supportsKeyCombination) {
    await adb.executeCommand("shell input keyevent KEYCODE_DEL");
    onDelete?.();
    signal?.throwIfAborted();
    return;
  }

  for (let index = 0; index < count; index += DELETE_KEYEVENT_CHUNK_SIZE) {
    signal?.throwIfAborted();
    const chunkSize = Math.min(DELETE_KEYEVENT_CHUNK_SIZE, count - index);
    const deleteKeyEvents = Array<string>(chunkSize).fill("KEYCODE_DEL").join(" ");
    await adb.executeCommand(`shell input keyevent ${deleteKeyEvents}`);
    onDelete?.();
    signal?.throwIfAborted();
  }
}

/** Verify a key-event clear using a fresh capture supplied by the caller's observer. */
export async function verifyKeyEventClear(
  observe: () => Promise<ObserveResult>,
  signal?: AbortSignal,
  parser: ElementParser = new DefaultElementParser(),
): Promise<ClearTextResult> {
  throwIfAborted(signal);
  try {
    const observation = await observe();
    throwIfAborted(signal);
    const hierarchy = observation.viewHierarchy;
    if (
      observation.freshness?.isFresh === false ||
      !hierarchy ||
      hierarchy.hierarchy.error ||
      !hasFocusedTextInput(hierarchy, parser)
    ) {
      return {
        success: false,
        error: "Cannot verify key-event clear: no fresh focused editable field available",
      };
    }
    const remaining = getFocusedTextLength(hierarchy, parser);
    if (remaining === undefined) {
      return {
        success: false,
        error: "Cannot verify key-event clear: focused field text length is unreadable",
      };
    }
    return remaining === 0
      ? { success: true }
      : {
          success: false,
          error: `Field was not fully cleared: ${remaining} UTF-16 units remain`,
        };
  } catch (error) {
    throwIfAborted(signal);
    logger.warn("[ClearText] Key-event clear verification unavailable", error);
    return { success: false, error: `Cannot verify key-event clear: ${errorMessage(error)}` };
  }
}

export class ClearText extends BaseVisualChange {
  private parser: ElementParser;
  private androidKeyCombinationSupported: Promise<boolean> | undefined;

  constructor(
    device: BootedDevice,
    adb: AdbClient | null = null,
    parser: ElementParser = new DefaultElementParser(),
    timer: Timer = defaultTimer,
  ) {
    super(device, adb, timer);
    this.parser = parser;
  }

  async execute(progress?: ProgressCallback, signal?: AbortSignal): Promise<ClearTextResult> {
    signal?.throwIfAborted();
    const perf = createGlobalPerformanceTracker();
    perf.serial("clearText");

    return this.observedInteraction(
      async (observeResult: ObserveResult) => {
        try {
          // Platform-specific clear text execution
          switch (this.device.platform) {
            case "android":
              return await perf.track("androidClearText", () =>
                this.executeAndroidClearText(observeResult, signal),
              );
            case "ios":
              return await perf.track("iOSClearText", () =>
                this.executeiOSClearText(observeResult, signal),
              );
            default:
              perf.end();
              throw unsupportedPlatformError(this.device.platform, "clear text");
          }
        } catch (error) {
          perf.end();
          signal?.throwIfAborted();
          const actionableError = toActionableError(error, "Failed to clear text");
          logger.warn(`[ClearText] ${actionableError.message}`);
          return {
            success: false,
            error: actionableError.message,
          };
        }
      },
      {
        changeExpected: false, // Whether text changed cannot be determined reliably.
        tolerancePercent: 0.0,
        timeoutMs: 100,
        progress,
        signal,
        perf,
        skipUiStability: true, // Skip UI stability wait - a11y service already waits 100ms for tree update
      },
    );
  }

  /**
   * Execute Android-specific clear text using accessibility service.
   * Falls back to ADB delete key events if a11y service is unavailable.
   */
  private async executeAndroidClearText(
    observeResult: ObserveResult,
    signal?: AbortSignal,
  ): Promise<ClearTextResult> {
    const viewHierarchy = observeResult.viewHierarchy;
    let fallbackObserveResult = observeResult;
    if (
      viewHierarchy &&
      !viewHierarchy.hierarchy.error &&
      !hasFocusedTextInput(viewHierarchy, this.parser)
    ) {
      const refreshedObserveResult = await this.refreshFocusedTextInputObservation(
        viewHierarchy,
        signal,
      ).catch((error: unknown) => {
        signal?.throwIfAborted();
        logger.warn("[ClearText] Focus refresh unavailable; trying live clearing", error);
        return undefined;
      });
      if (
        refreshedObserveResult?.viewHierarchy &&
        !hasFocusedTextInput(refreshedObserveResult.viewHierarchy, this.parser)
      ) {
        return {
          success: false,
          error: "No focused editable node found",
        };
      }
      fallbackObserveResult = refreshedObserveResult ?? {
        ...observeResult,
        viewHierarchy: undefined,
      };
    }

    // Use accessibility service (fastest method, ~50-80ms vs ~200-500ms for ADB deletes)
    const a11yClient = AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
    signal?.throwIfAborted();
    const a11yResult = await a11yClient.requestClearText();
    signal?.throwIfAborted();

    if (a11yResult.success) {
      logger.info(
        `[ClearText] Cleared text via accessibility service: ${a11yResult.totalTimeMs}ms`,
      );
      return { success: true };
    }

    // Fall back to ADB delete key events
    logger.warn(
      `[ClearText] Accessibility service clear failed: ${a11yResult.error}, falling back to ADB`,
    );
    return this.executeAdbClearText(fallbackObserveResult, signal);
  }

  /** Returns a fresh usable hierarchy, or undefined when focus cannot be determined. */
  private async refreshFocusedTextInputObservation(
    viewHierarchy: ViewHierarchyResult,
    signal?: AbortSignal,
  ): Promise<ObserveResult | undefined> {
    let minTimestamp: number;
    if (typeof viewHierarchy.updatedAt === "number") {
      minTimestamp = viewHierarchy.updatedAt + 1;
    } else {
      signal?.throwIfAborted();
      const timestampResult = await this.adb.getDeviceTimestampMsWithSource();
      signal?.throwIfAborted();
      if (timestampResult.source === "host") {
        return undefined;
      }
      minTimestamp =
        timestampResult.source === "device-seconds"
          ? timestampResult.timestampMs + DEVICE_TIMESTAMP_SECOND_GRANULARITY_MARGIN_MS
          : timestampResult.timestampMs;
    }

    signal?.throwIfAborted();
    const refreshedObserveResult = await this.observeScreen.execute({
      freshness: "fresh",
      minTimestamp,
      signal,
    });
    signal?.throwIfAborted();
    const refreshedViewHierarchy = refreshedObserveResult.viewHierarchy;
    return refreshedObserveResult.freshness?.isFresh !== false &&
      refreshedViewHierarchy &&
      !refreshedViewHierarchy.hierarchy.error
      ? refreshedObserveResult
      : undefined;
  }

  /**
   * [LEGACY] Execute clear text using ADB delete key events.
   * Kept as fallback if accessibility service is unavailable.
   */
  private async executeAdbClearText(
    observeResult: ObserveResult,
    signal?: AbortSignal,
  ): Promise<ClearTextResult> {
    const hierarchy = observeResult.viewHierarchy;
    const textLength =
      hierarchy && !hierarchy.hierarchy.error
        ? getFocusedTextLength(hierarchy, this.parser)
        : undefined;
    const count = textLength ?? 200;
    if (count === 0) {
      return { success: true };
    }
    await this.clearWithDeletes(count, signal);
    return verifyKeyEventClear(
      () => this.observeScreen.execute({ freshness: "fresh", minTimestamp: 0, signal }),
      signal,
      this.parser,
    );
  }

  /**
   * Execute iOS-specific clear text using CtrlProxy iOS.
   */
  private async executeiOSClearText(
    observeResult: ObserveResult,
    signal?: AbortSignal,
  ): Promise<ClearTextResult> {
    const startMs = Date.now();
    logger.debug(`[ClearText] iOS begin`);
    try {
      const client = IOSCtrlProxyClient.getInstance(this.device);
      signal?.throwIfAborted();
      const result = await client.requestClearText();
      signal?.throwIfAborted();

      if (result.success) {
        logger.info(`[ClearText] Cleared text via CtrlProxy iOS totalMs=${Date.now() - startMs}`);
        return { success: true };
      }

      logger.warn(
        `[ClearText] CtrlProxy iOS clear failed: ${result.error} totalMs=${Date.now() - startMs}`,
      );
      return { success: false, error: result.error };
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(
        `[ClearText] CtrlProxy iOS exception: ${errorMessage(error)} totalMs=${Date.now() - startMs}`,
        error,
      );
      return { success: false, error: String(error) };
    }
  }

  private findAnyTextInputLength(viewHierarchy: ViewHierarchyResult): number {
    let textLength = 0;
    for (const rootGroup of extractSearchRootGroups(viewHierarchy, this.parser)) {
      for (const rootNode of rootGroup) {
        this.parser.traverseNode(rootNode, (node: any) => {
          const nodeProperties = this.parser.extractNodeProperties(node);
          const text = toSearchable(nodeProperties).textSources.text;
          if (
            nodeProperties.class &&
            ANDROID_INPUT_CLASSES.some((cls) => nodeProperties.class.includes(cls)) &&
            text &&
            typeof text === "string"
          ) {
            textLength = Math.max(textLength, text.length);
          }
        });
      }
    }

    return textLength;
  }

  private async clearWithDeletes(count: number, signal?: AbortSignal): Promise<void> {
    // Resolve this optional capability once, before moving the caret or deleting.
    this.androidKeyCombinationSupported ??= readAndroidDeviceApiLevel(this.adb, 1000, this.timer)
      .then((apiLevel) => apiLevel !== null && apiLevel >= ANDROID_KEYCOMBINATION_MIN_API_LEVEL)
      .catch((error) => {
        // Unexpected probe rejection must allow the next request to retry.
        this.androidKeyCombinationSupported = undefined;
        throw toActionableError(error, "Failed to read Android key-combination capability");
      });
    const supportsKeyCombination = await awaitWhileRequestIsLive(
      this.androidKeyCombinationSupported,
      signal,
    );
    await clearTextWithKeyEvents(this.adb, count, signal, undefined, supportsKeyCombination);
  }
}
