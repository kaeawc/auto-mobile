import { toActionableError, unsupportedPlatformError } from "../../models/ActionableError";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import { BootedDevice, ClearTextResult, ViewHierarchyResult } from "../../models";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { DefaultElementParser } from "../utility/ElementParser";
import { ObserveResult } from "../../models";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { logger } from "../../utils/logger";
import { toSearchable } from "../utility/SearchableNode";
import { ANDROID_INPUT_CLASSES } from "../../utils/elementProperties";

export const DEVICE_TIMESTAMP_SECOND_GRANULARITY_MARGIN_MS = 1000;

export function getFocusedTextLength(
  viewHierarchy: ViewHierarchyResult,
  parser: ElementParser = new DefaultElementParser(),
): number | undefined {
  let textLength: number | undefined;
  const rootNodes = parser.extractRootNodes(viewHierarchy);

  for (const rootNode of rootNodes) {
    parser.traverseNode(rootNode, (node: any) => {
      const nodeProperties = parser.extractNodeProperties(node);
      const searchable = toSearchable(nodeProperties);
      const displayText = searchable.textSources;
      const text = displayText.value ?? displayText.text;
      const length = typeof text === "string" ? text.length : searchable.capturedTextLength;
      if (
        (nodeProperties.focused === "true" || nodeProperties.focused === true) &&
        length !== undefined
      ) {
        textLength = Math.max(textLength ?? 0, length);
      }
    });
  }

  return textLength;
}

export function hasFocusedTextInput(
  viewHierarchy: ViewHierarchyResult,
  parser: ElementParser = new DefaultElementParser(),
): boolean {
  const rootNodes = parser.extractRootNodes(viewHierarchy);

  for (const rootNode of rootNodes) {
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

  return false;
}

function isFocusedTextInputProperties(nodeProperties: Record<string, unknown>): boolean {
  if (nodeProperties.focused !== "true" && nodeProperties.focused !== true) {
    return false;
  }
  const nodeClass = nodeProperties.class ?? nodeProperties.className;
  const hasKnownInputClass =
    typeof nodeClass === "string" &&
    ANDROID_INPUT_CLASSES.some((inputClass) => nodeClass.includes(inputClass));
  const actions = nodeProperties.actions;
  const exposesTextAction = Array.isArray(actions) && actions.includes("set_text");
  const explicitlyEditable = nodeProperties.editable === "true" || nodeProperties.editable === true;
  return hasKnownInputClass || exposesTextAction || explicitlyEditable;
}

export async function clearTextWithKeyEvents(
  adb: AdbExecutor,
  count: number,
  signal?: AbortSignal,
  onDelete?: () => void,
): Promise<void> {
  signal?.throwIfAborted();
  await adb.executeCommand("shell input keyevent KEYCODE_MOVE_END");
  signal?.throwIfAborted();

  for (let index = 0; index < count; index++) {
    await adb.executeCommand("shell input keyevent KEYCODE_DEL");
    onDelete?.();
    signal?.throwIfAborted();
  }
}

export class ClearText extends BaseVisualChange {
  private parser: ElementParser;

  constructor(
    device: BootedDevice,
    adb: AdbClient | null = null,
    parser: ElementParser = new DefaultElementParser(),
  ) {
    super(device, adb);
    this.parser = parser;
  }

  async execute(progress?: ProgressCallback): Promise<ClearTextResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("clearText");

    return this.observedInteraction(
      async (observeResult: ObserveResult) => {
        try {
          // Platform-specific clear text execution
          switch (this.device.platform) {
            case "android":
              return await perf.track("androidClearText", () =>
                this.executeAndroidClearText(observeResult),
              );
            case "ios":
              return await perf.track("iOSClearText", () =>
                this.executeiOSClearText(observeResult),
              );
            default:
              perf.end();
              throw unsupportedPlatformError(this.device.platform, "clear text");
          }
        } catch (error) {
          perf.end();
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
        perf,
        skipUiStability: true, // Skip UI stability wait - a11y service already waits 100ms for tree update
      },
    );
  }

  /**
   * Execute Android-specific clear text using accessibility service.
   * Falls back to ADB delete key events if a11y service is unavailable.
   */
  private async executeAndroidClearText(observeResult: ObserveResult): Promise<ClearTextResult> {
    const viewHierarchy = observeResult.viewHierarchy;
    let fallbackObserveResult = observeResult;
    if (
      viewHierarchy &&
      !viewHierarchy.hierarchy.error &&
      !hasFocusedTextInput(viewHierarchy, this.parser)
    ) {
      const refreshedObserveResult = await this.refreshFocusedTextInputObservation(
        viewHierarchy,
      ).catch((error: unknown) => {
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
    const a11yResult = await a11yClient.requestClearText();

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
    return this.executeAdbClearText(fallbackObserveResult);
  }

  /** Returns a fresh usable hierarchy, or undefined when focus cannot be determined. */
  private async refreshFocusedTextInputObservation(
    viewHierarchy: ViewHierarchyResult,
  ): Promise<ObserveResult | undefined> {
    let minTimestamp: number;
    if (typeof viewHierarchy.updatedAt === "number") {
      minTimestamp = viewHierarchy.updatedAt + 1;
    } else {
      const timestampResult = await this.adb.getDeviceTimestampMsWithSource();
      if (timestampResult.source === "host") {
        return undefined;
      }
      minTimestamp =
        timestampResult.source === "device-seconds"
          ? timestampResult.timestampMs + DEVICE_TIMESTAMP_SECOND_GRANULARITY_MARGIN_MS
          : timestampResult.timestampMs;
    }

    const refreshedObserveResult = await this.observeScreen.execute({
      skipWaitForFresh: false,
      minTimestamp,
    });
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
  private async executeAdbClearText(observeResult: ObserveResult): Promise<ClearTextResult> {
    if (!observeResult.viewHierarchy || observeResult.viewHierarchy.hierarchy.error) {
      // Fallback: if we can't get view hierarchy, use a reasonable default
      await this.clearWithDeletes(200);
      return { success: true };
    }

    const textLength = getFocusedTextLength(observeResult.viewHierarchy, this.parser);
    if (textLength === undefined) {
      await this.clearWithDeletes(200);
      return { success: true };
    }

    // Cursor position is not moved to the end of the text.

    if (textLength > 0) {
      await this.clearWithDeletes(textLength);
    }

    return { success: true };
  }

  /**
   * Execute iOS-specific clear text using CtrlProxy iOS.
   */
  private async executeiOSClearText(observeResult: ObserveResult): Promise<ClearTextResult> {
    const startMs = Date.now();
    logger.debug(`[ClearText] iOS begin`);
    try {
      const client = IOSCtrlProxyClient.getInstance(this.device);
      const result = await client.requestClearText();

      if (result.success) {
        logger.info(`[ClearText] Cleared text via CtrlProxy iOS totalMs=${Date.now() - startMs}`);
        return { success: true };
      }

      logger.warn(
        `[ClearText] CtrlProxy iOS clear failed: ${result.error} totalMs=${Date.now() - startMs}`,
      );
      return { success: false, error: result.error };
    } catch (error) {
      logger.error(`[ClearText] CtrlProxy iOS exception: ${error} totalMs=${Date.now() - startMs}`);
      return { success: false, error: String(error) };
    }
  }

  private findAnyTextInputLength(viewHierarchy: any): number {
    let textLength = 0;
    const rootNodes = this.parser.extractRootNodes(viewHierarchy);

    for (const rootNode of rootNodes) {
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

    return textLength;
  }

  private async clearWithDeletes(count: number): Promise<void> {
    await clearTextWithKeyEvents(this.adb, count);
  }
}
