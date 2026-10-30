import { isAndroidHintText } from "./androidHintText";
import { getTextRequestDeadlineMs } from "./textTransportTimeout";
import { clearIosFieldWithVerification } from "./iosClearVerification";
import { toActionableError, unsupportedPlatformError } from "../../models/ActionableError";
import { ANDROID_KEYCOMBINATION_MIN_API_LEVEL } from "../../utils/android-cmdline-tools/asciiKeyEvents";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
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
import { nodeBounds } from "../../models/ViewHierarchyResult";
import { parseBounds } from "../../utils/bounds";
import { IosKeyboardNativeEditableTracker } from "./iosKeyboardNativeEditable";
import { readIosTokenField } from "./iosTokenField";
import { ANDROID_INPUT_CLASSES, isTruthyFlag } from "../utility/elementProperties";
import { OBSERVED_INTERACTION_PROFILES, SETTLE_BUDGET_MS } from "./observedInteractionProfiles";

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
  const android = ["android.", "androidx."].some((prefix) =>
    searchable.className?.startsWith(prefix),
  );
  // SendKeys includes the raw hint length for deletes so replace cannot under-delete
  // that real text; the existing clear sequence runs before verification and typing.
  if (!includeHintText && isAndroidHintText(searchable.className, properties["hint-text"], text)) {
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

/**
 * Stable identity of the focused editable control: resource id, class and top-left corner. The
 * size is left out so a multiline field that grows after a newline keeps its identity.
 */
export function getFocusedTextFieldIdentity(
  viewHierarchy: ViewHierarchyResult,
  parser: ElementParser = new DefaultElementParser(),
): string | undefined {
  for (const rootGroup of extractSearchRootGroups(viewHierarchy, parser)) {
    let identity: string | undefined;
    for (const rootNode of rootGroup) {
      parser.traverseNode(rootNode, (node: ViewHierarchyNode) => {
        const properties = parser.extractNodeProperties(node);
        if (identity !== undefined || !isFocusedTextInputProperties(properties)) {
          return;
        }
        const searchable = toSearchable(properties);
        identity = JSON.stringify([
          searchable.nativeId ?? null,
          searchable.className ?? null,
          searchable.bounds?.left ?? null,
          searchable.bounds?.top ?? null,
        ]);
      });
    }
    if (identity !== undefined) {
      return identity;
    }
  }
  return undefined;
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
  /** Non-secure native iOS values, used only when native focus is unavailable. */
  nativeEditableValues?: Readonly<Record<string, string>>;
  /** Value of the sole native iOS editable above the on-screen keyboard (blank reads as ""). */
  keyboardNativeEditableValue?: string;
  /** Committed token labels of a recipient/token field; absent for an ordinary text field. */
  tokens?: readonly string[];
  /** A token field's value minus its token labels: the text typed after the last token. */
  trailingText?: string;
}

export interface FocusedTextFieldOptions {
  /** Typing verification can compare native inputs when WebKit focus is unreliable. */
  includeIosNativeEditableValues?: boolean;
  /**
   * iOS runners omit an empty field's value and XCUI can report the placeholder as the value, so a
   * focused editable with no value, or a value equal to its placeholder, reads as "" (#9078).
   */
  iosEmptyAsBlank?: boolean;
  /** Treat an iOS value equal to its placeholder as blank, while omitted values stay unreadable.
   * Read only the runner value; never fall back to the field's text or accessibility label. */
  iosPlaceholderAsBlank?: boolean;
}

/** Preserve security metadata even when a focused field's value is unreadable. */
export function getFocusedTextField(
  viewHierarchy: ViewHierarchyResult,
  parser: ElementParser = new DefaultElementParser(),
  options: FocusedTextFieldOptions = {},
): FocusedTextField | undefined {
  for (const rootGroup of extractSearchRootGroups(viewHierarchy, parser)) {
    let firstField: FocusedTextField | undefined;
    const nativeEditableValues: Record<string, string> | undefined =
      options.includeIosNativeEditableValues ? {} : undefined;
    const keyboardTracker = options.includeIosNativeEditableValues
      ? new IosKeyboardNativeEditableTracker()
      : undefined;
    for (const root of rootGroup) {
      let nativeField: FocusedTextField | undefined;
      let webViewDepth: number | undefined;
      parser.traverseNode(root, (node: ViewHierarchyNode, depth: number) => {
        if (webViewDepth !== undefined && depth <= webViewDepth) {
          webViewDepth = undefined;
        }
        const properties = parser.extractNodeProperties(node);
        const nodeClass = properties.class ?? properties.className;
        if (webViewDepth === undefined && nodeClass === "WKWebView") {
          webViewDepth = depth;
        }
        if (webViewDepth === undefined) {
          captureIosNativeEditableValue(properties, nativeEditableValues);
          trackKeyboardNativeEditable(node, properties, keyboardTracker);
        }
        if (!isFocusedTextInputProperties(properties)) {
          return;
        }
        const field = readFocusedTextFieldWithTokens(node, properties, options, parser);
        if (field === undefined) {
          return;
        }
        // Web content can report its own focused field (a page search box) beside the native
        // one that owns the keyboard (Safari's URL field); the native field is the typing target.
        firstField ??= field;
        nativeField ??= webViewDepth === undefined ? field : undefined;
      });
      if (nativeField !== undefined) {
        return nativeField;
      }
    }
    if (nativeEditableValues && Object.keys(nativeEditableValues).length > 0) {
      return withNativeEditables(firstField, nativeEditableValues, keyboardTracker);
    }
    if (firstField !== undefined) {
      return firstField;
    }
  }
  return undefined;
}

/** Snapshot stable native input identities without ever copying secure values. */
function captureIosNativeEditableValue(
  properties: Record<string, unknown>,
  values: Record<string, string> | undefined,
): void {
  if (!values || isTruthyFlag(properties.focused) || !isNonSecureIosEditable(properties)) {
    return;
  }
  const searchable = toSearchable(properties);
  const id = properties["view-id"] ?? searchable.nativeId;
  if (typeof id === "string" && id !== "") {
    // Runner omissions represent empty native values; labels are never editable values.
    const value = typeof properties.value === "string" ? properties.value : "";
    // XCUI reports an empty field's placeholder as its value.
    values[id] = value === properties["hint-text"] ? "" : value;
  }
}

function withNativeEditables(
  field: FocusedTextField | undefined,
  nativeEditableValues: Record<string, string>,
  tracker: IosKeyboardNativeEditableTracker | undefined,
): FocusedTextField {
  const keyboardNativeEditableValue = tracker?.soleValueAboveKeyboard();
  return {
    ...(field ?? { secure: false }),
    nativeEditableValues,
    ...(keyboardNativeEditableValue === undefined ? {} : { keyboardNativeEditableValue }),
  };
}

function trackKeyboardNativeEditable(
  node: ViewHierarchyNode,
  properties: Record<string, unknown>,
  tracker: IosKeyboardNativeEditableTracker | undefined,
): void {
  if (!tracker) {
    return;
  }
  const nodeClass = properties.class ?? properties.className;
  if (nodeClass === "UIKeyboard") {
    tracker.recordKeyboard(parseBounds(nodeBounds(node)));
    return;
  }
  if (isNonSecureIosEditable(properties)) {
    const value = typeof properties.value === "string" ? properties.value : "";
    tracker.recordEditable(
      value === properties["hint-text"] ? "" : value,
      parseBounds(nodeBounds(node)),
    );
  }
}

function isSecureTextInput(properties: Record<string, unknown>): boolean {
  const nodeClass = properties.class ?? properties.className;
  return (
    isTruthyFlag(properties.password) ||
    (typeof nodeClass === "string" && nodeClass.includes("SecureTextField"))
  );
}

function isNonSecureIosEditable(properties: Record<string, unknown>): boolean {
  const nodeClass = properties.class ?? properties.className;
  if (isSecureTextInput(properties)) {
    return false;
  }
  return (
    properties.role === "textfield" ||
    (Array.isArray(properties.actions) && properties.actions.includes("set_text")) ||
    (typeof nodeClass === "string" && /UITextField|UISearchBar|UITextView/.test(nodeClass))
  );
}

function readFocusedTextField(
  properties: Record<string, unknown>,
  options: FocusedTextFieldOptions,
): FocusedTextField | undefined {
  const searchable = toSearchable(properties);
  const secure = isSecureTextInput(properties);
  // Text sources preserve editable values; captured length distinguishes empty text from absence.
  const defaultValue =
    searchable.textSources.value ??
    searchable.textSources.text ??
    (searchable.capturedTextLength === 0 ? "" : undefined);
  if (secure) {
    return { value: defaultValue, secure };
  }
  const value = options.iosEmptyAsBlank
    ? iosFieldValueOrBlank(searchable.textSources)
    : options.iosPlaceholderAsBlank
      ? searchable.textSources.value === undefined
        ? undefined
        : iosFieldValueOrBlank(searchable.textSources)
      : defaultValue;
  // A known native focused input remains the target even when its value is unreadable.
  // Typing verification must not substitute unrelated native inputs in that case.
  return value !== undefined || options.includeIosNativeEditableValues
    ? { value, secure }
    : undefined;
}

/** The focused field's value, plus the committed tokens of a recipient/token field. */
function readFocusedTextFieldWithTokens(
  node: ViewHierarchyNode,
  properties: Record<string, unknown>,
  options: FocusedTextFieldOptions,
  parser: ElementParser,
): FocusedTextField | undefined {
  const field = readFocusedTextField(properties, options);
  if (field === undefined || field.secure) {
    return field;
  }
  const tokenState = readIosTokenField(node, field.value, parser);
  return tokenState === undefined ? field : { ...field, ...tokenState };
}

function iosFieldValueOrBlank(textSources: Readonly<Record<string, string>>): string {
  const value = textSources.value;
  return value === undefined || value === textSources["hint-text"] ? "" : value;
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
  {
    signal,
    onDelete,
    supportsKeyCombination,
  }: { signal?: AbortSignal; onDelete?: () => void; supportsKeyCombination?: boolean } = {},
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
    adb: AdbExecutor | AdbClientFactory | null = null,
    parser: ElementParser = new DefaultElementParser(),
    timer: Timer = defaultTimer,
  ) {
    super(device, adb, timer);
    this.parser = parser;
  }

  async execute(
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<ClearTextResult & { retryable?: false }> {
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
        // Whether text changed cannot be determined reliably; the a11y service already waited for the tree.
        ...OBSERVED_INTERACTION_PROFILES.textEdit,
        tolerancePercent: 0.0,
        timeoutMs: SETTLE_BUDGET_MS.immediate,
        progress,
        signal,
        perf,
      },
    );
  }

  /**
   * Execute Android-specific clear text using accessibility service.
   * Falls back to ADB delete key events if a11y service is unavailable.
   */
  /** @internal Typed view of private execution paths for unit tests; not part of the public API. */
  get testHooks() {
    return {
      executeAndroidClearText: this.executeAndroidClearText.bind(this),
      executeiOSClearText: this.executeiOSClearText.bind(this),
    };
  }

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
      skipScreenshot: true,
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
      () =>
        this.observeScreen.execute({
          freshness: "fresh",
          minTimestamp: 0,
          signal,
          skipScreenshot: true,
        }),
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
  ): Promise<ClearTextResult & { retryable?: false }> {
    const startMs = Date.now();
    logger.debug(`[ClearText] iOS begin`);
    try {
      const client = IOSCtrlProxyClient.getInstance(this.device);
      signal?.throwIfAborted();
      const clear = () => {
        const deadlineMs = getTextRequestDeadlineMs();
        return client.requestClearText(undefined, 5000, undefined, {
          abortSignal: signal,
          ...(deadlineMs === undefined ? {} : { deadlineMs }),
        });
      };
      const result = await clearIosFieldWithVerification({
        clear,
        observer: this.observeScreen,
        timer: this.timer,
        signal,
      });
      if (result.retryable !== false) {
        signal?.throwIfAborted();
      }

      if (result.success) {
        logger.info(`[ClearText] Cleared text via CtrlProxy iOS totalMs=${Date.now() - startMs}`);
        return {
          success: true,
          ...("warning" in result && result.warning ? { warnings: [result.warning] } : {}),
        };
      }

      logger.warn(
        `[ClearText] CtrlProxy iOS clear failed: ${result.error} totalMs=${Date.now() - startMs}`,
      );
      return {
        success: false,
        error: result.error,
        ...(result.retryable === false ? { retryable: false as const } : {}),
      };
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
    await clearTextWithKeyEvents(this.adb, count, { signal, supportsKeyCombination });
  }
}
