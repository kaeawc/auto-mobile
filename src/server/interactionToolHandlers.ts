import {
  ActionableError,
  BootedDevice,
  ClipboardResult,
  OpenURLResult,
  requireAndroidOrIosPlatform,
  type ObserveResult,
  type TapOnElementResult,
} from "../models";
import type {
  ClipboardArgs,
  KeyboardArgs,
  OpenLinkArgs,
  RecentAppsArgs,
  SendKeysArgs,
  ShakeArgs,
  SystemTrayArgs,
  WakeAndUnlockArgs,
} from "./interactionToolTypes";
import { AndroidCtrlProxyClient, type AndroidCtrlProxy } from "../features/observe/android";
import { androidCtrlProxyClientFor } from "../features/observe/android/androidCtrlProxyClientFor";
import {
  KEYBOARD_PROFILE_CATALOG_ID,
  KEYBOARD_PROFILE_CATALOG_VERSIONS,
  KEYBOARD_PROFILE_IDS,
  type KeyboardProfileCatalog,
} from "../features/action/keyboardProfiles";
import {
  createStructuredToolResponse,
  throwIfAborted,
  withIsErrorOnFailure,
} from "../utils/toolUtils";
import type {
  AcceptIosAppOpenAlertOptions,
  InteractionToolDependencies,
  OpenAlertHierarchyRefresh,
  OpenAlertResolution,
  OpenLinkWaitOutcome,
  SendKeysRunnerCommandSourceFactory,
  SystemAlertTap,
} from "./interactionTools/dependencies";
import { IOSCtrlProxyClient, type IosCtrlProxy } from "../features/observe/ios";
import { HandleIntentChooser } from "../features/action/HandleIntentChooser";
import { SendKeys } from "../features/action/SendKeys";
import { TapOnElement } from "../features/action/TapOnElement";
import { nodeAttributes } from "../models/ViewHierarchyResult";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { fixedBackoff } from "../utils/Backoff";
import { IosOpenAlertError, selectIosOpenAlertAcceptButton } from "./iosOpenAlert";
import { ProgressCallback } from "./toolRegistry";
import { createInstalledImeKeySession } from "../features/action/InstalledImeKeySession";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import {
  AndroidImeCatalog,
  createForegroundUserSource,
} from "../features/action/AndroidImeCatalog";
import { Keyboard, KeyboardOpenIndeterminateError } from "../features/action/Keyboard";
import { OpenURL } from "../features/action/OpenURL";
import { Shake } from "../features/action/Shake";
import { RecentApps } from "../features/action/RecentApps";
import { Clipboard } from "../features/action/Clipboard";
import { WakeAndUnlock } from "../features/action/WakeAndUnlock";
import { DeviceLockStore } from "../devices/DeviceLockStore";
import { IosLockScreenUnlocker } from "../features/action/IosLockScreenUnlocker";
import { SystemTray } from "../features/systemTray/SystemTray";
import { RecompositionTracker } from "../features/performance/RecompositionTracker";
import { dismissKeyboardAfterSendKeys } from "../features/action/dismissKeyboardAfterSendKeys";
import { serverConfig } from "../utils/ServerConfig";
import { INTERNAL_MCP_REQUEST_DEADLINE_PARAM } from "../daemon/wire/constants";
import { assertActiveWindowWaitForSupportedOnPlatform, waitForObservation } from "./observeTools";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { displayWaitInventory } from "../utils/deviceMatcher";
import { toActionableError } from "../models/ActionableError";
import { HomeScreen } from "../features/action/HomeScreen";
import {
  defaultKeyboardProfileRestoreRegistry,
  resetKeyboardProfileFromRecord,
  setKeyboardProfileRecorded,
  type KeyboardProfileRestoreRegistry,
} from "../features/utility/KeyboardProfileRestore";
import { defaultDaemonContext } from "../daemon/daemonContext";
import { runSessionKeyboardProfileMutation } from "./sessionKeyboardProfile";

type KeyboardProfileWriteClient = Pick<AndroidCtrlProxy, "supportsCommand" | "setKeyboardProfile">;

export interface KeyboardProfileRecordOptions {
  /** The daemon session changing the profile, whose release restores it; none when sessionless. */
  owner?: string;
  registry?: KeyboardProfileRestoreRegistry;
}

/**
 * `keyboard setProfile`: switch the AutoMobile IME's behaviour profile, recording
 * the profile active before the first change (#14705) so the owning session's
 * release, or a persona reset, can put it back.
 */
export async function setKeyboardProfileForTool(
  device: BootedDevice,
  profile: KeyboardArgs["profile"],
  client?: KeyboardProfileWriteClient,
  signal?: AbortSignal,
  record: KeyboardProfileRecordOptions = {},
): Promise<{ activeProfileId?: string; previousProfileId?: string }> {
  if (!profile) {
    throw new ActionableError(
      `keyboard setProfile requires profile: ${KEYBOARD_PROFILE_IDS.join(", ")}.`,
    );
  }
  const registry = record.registry ?? defaultKeyboardProfileRestoreRegistry;
  return setKeyboardProfileRecorded(device, profile, client, signal, {
    owner: record.owner,
    registry,
  });
}

/**
 * Put back the keyboard profile recorded before the first change and forget it
 * (#14705). With nothing recorded it changes nothing; a refused write stays
 * recorded, so a later reset or the owning session's release retries it.
 */
export async function resetKeyboardProfileForTool(
  device: BootedDevice,
  client?: KeyboardProfileWriteClient,
  signal?: AbortSignal,
  registry: KeyboardProfileRestoreRegistry = defaultKeyboardProfileRestoreRegistry,
): Promise<{ restoredProfileId?: string }> {
  return resetKeyboardProfileFromRecord(device, client, signal, registry);
}

export async function listKeyboardProfilesForTool(
  device: BootedDevice,
  client?: Pick<AndroidCtrlProxy, "supportsCommand" | "listKeyboardProfiles">,
  signal?: AbortSignal,
): Promise<KeyboardProfileCatalog> {
  if (device.platform !== "android") {
    throw new ActionableError(
      "AutoMobile keyboard profiles are Android-only; select an Android device.",
    );
  }
  const profileClient = client ?? androidCtrlProxyClientFor(device);
  const command = "request_list_keyboard_profiles";
  const supported = await profileClient.supportsCommand(command);
  throwIfAborted(signal);
  if (!supported) {
    throw new ActionableError(
      "The installed control-proxy build does not support keyboard profile catalogs; update/re-cut the APK.",
    );
  }
  const catalog = await profileClient.listKeyboardProfiles();
  if (!catalog.success) {
    throw new ActionableError(catalog.error ?? "Failed to list AutoMobile keyboard profiles.");
  }
  validateKeyboardProfileCatalog(catalog);
  return catalog;
}

function validateKeyboardProfileCatalog(catalog: KeyboardProfileCatalog): void {
  if (catalog.catalogId !== KEYBOARD_PROFILE_CATALOG_ID) {
    throw new ActionableError(`Unsupported keyboard profile catalog '${catalog.catalogId}'.`);
  }
  if (
    catalog.catalogVersion === undefined ||
    !KEYBOARD_PROFILE_CATALOG_VERSIONS.some((version) => version === catalog.catalogVersion)
  ) {
    throw new ActionableError(
      `Unsupported keyboard profile catalog version '${catalog.catalogVersion ?? "missing"}'.`,
    );
  }
  if (!catalog.profiles?.length || !catalog.activeProfileId) {
    throw new ActionableError("The AutoMobile keyboard profile catalog is incomplete.");
  }
  if (!catalog.profiles.some(({ id }) => id === catalog.activeProfileId)) {
    throw new ActionableError("The active AutoMobile keyboard profile is not in its catalog.");
  }
}

const defaultSendKeysRunnerCommandSourceFactory: SendKeysRunnerCommandSourceFactory = (device) =>
  device.platform === "android"
    ? AndroidCtrlProxyClient.getInstance(device)
    : IOSCtrlProxyClient.getInstance(device);

export async function assertSendKeysRunnerCompatible(
  device: BootedDevice,
  sourceFactory: SendKeysRunnerCommandSourceFactory = defaultSendKeysRunnerCommandSourceFactory,
): Promise<void> {
  const requiredCommand =
    device.platform === "android" ? "request_insert_text" : "request_press_key";
  const supportedCommands = await sourceFactory(device).getSupportedCommands();
  if (supportedCommands?.includes(requiredCommand)) {
    return;
  }
  throw new ActionableError(
    `${device.platform === "android" ? "Android CtrlProxy APK" : "iOS CtrlProxy runner"} ` +
      `does not support sendKeys (${requiredCommand} is unavailable). Rebuild and redeploy the ` +
      `CtrlProxy from this source checkout.`,
  );
}

function confirmsPostTapPackage(
  selection: Awaited<ReturnType<HandleIntentChooser["execute"]>>,
  packageName: string,
): boolean {
  const observed = selection.observation?.viewHierarchy;
  return (
    selection.tappedAt !== undefined &&
    observed?.updatedAt !== undefined &&
    observed.updatedAt >= selection.tappedAt &&
    observed.packageName === packageName
  );
}

/**
 * Selects the requested Android link handler and fails unless the chooser
 * reports success and, when needed, a fresh hierarchy confirms the package.
 */
export async function selectAndroidOpenLinkChooser(
  device: BootedDevice,
  packageName: string,
  opened: OpenURLResult,
  {
    url,
    chooser = new HandleIntentChooser(device),
    signal,
  }: { url?: string; chooser?: Pick<HandleIntentChooser, "execute">; signal?: AbortSignal },
): Promise<OpenURLResult> {
  if (device.platform !== "android") {
    throw new ActionableError("chooserAppPackage is supported only on Android.");
  }
  if (!opened.success) {
    return opened;
  }
  throwIfAborted(signal);
  const selection = await chooser.execute("custom", packageName, url, signal);
  throwIfAborted(signal);
  if (!selection.detected || !selection.success) {
    return {
      ...opened,
      success: false,
      error: selection.error ?? `Intent chooser for ${packageName} was not found`,
      observation: selection.observation ?? opened.observation,
    };
  }
  if (selection.packageVerified === false && !confirmsPostTapPackage(selection, packageName)) {
    return {
      ...opened,
      success: false,
      error: `Unverified chooser selection for ${packageName}: the post-tap hierarchy is stale or does not confirm the foreground package.`,
      observation: selection.observation ?? opened.observation,
    };
  }
  return { ...opened, observation: selection.observation ?? opened.observation };
}

/**
 * Build the openLink response payload. Without a wait it is the plain open
 * result; with a wait (issue #3490 §5) the awaited observation replaces the
 * open-time snapshot and the await metadata is surfaced to the caller.
 */
export const buildOpenLinkPayload = (
  url: string,
  openResult: OpenURLResult,
  waitOutcome: OpenLinkWaitOutcome | null,
) => {
  const message = openResult.success
    ? `Opened link ${url}`
    : `Failed to open ${url}: ${openResult.error || "unknown error"}`;
  if (!waitOutcome) {
    return {
      message,
      ...openResult,
      observation: openResult.observation,
    };
  }
  return {
    message,
    ...openResult,
    observation: waitOutcome.observation,
    awaitedElement: waitOutcome.awaitedElement,
    awaitDuration: waitOutcome.awaitDuration,
    awaitTimeout: waitOutcome.awaitTimeout,
    matched: waitOutcome.matched,
    settled: waitOutcome.settled,
    timedOut: waitOutcome.timedOut,
    timeoutReason: waitOutcome.timeoutReason,
    polls: waitOutcome.polls,
    waitMs: waitOutcome.waitMs,
    matchedElement: waitOutcome.matchedElement,
    candidates: waitOutcome.candidates,
  };
};

export function formatClipboardMessage(result: ClipboardResult): string {
  if (!result.success) {
    return `Failed to execute clipboard ${result.action}: ${result.error ?? "unknown error"}`;
  }

  switch (result.action) {
    case "copy":
      return "Copied text to clipboard";
    case "paste":
      return "Pasted clipboard content into focused field";
    case "clear":
      return "Cleared clipboard";
    case "get":
      return result.text
        ? `Retrieved clipboard content: "${result.text.substring(0, 50)}${result.text.length > 50 ? "..." : ""}"`
        : "Retrieved empty clipboard";
  }
}

export function formatRecentAppsMessage(result: { success?: boolean; error?: string }): string {
  if (result.success === false) {
    return `Failed to open recent apps: ${result.error ?? "unknown error"}`;
  }
  return "Opened recent apps";
}

const defaultSendKeysFactory: NonNullable<InteractionToolDependencies["sendKeysFactory"]> = (
  device,
) => new SendKeys(device);

export const defaultTapOnElementFactory: NonNullable<
  InteractionToolDependencies["tapOnElementFactory"]
> = (device) => new TapOnElement(device);

const VISIBLE_HIERARCHY_TEXT_KEYS = new Set([
  "text",
  "label",
  "content-desc",
  "contentDescription",
]);

const IOS_SYSTEM_DIALOG_CLASSES = new Set([
  "UIAlertController",
  "UIActionSheet",
  "XCUIElementTypeAlert",
  "XCUIElementTypeSheet",
]);

/** How long to wait for the "Open in ...?" alert after openurl; a loaded host animates it slowly. */
const IOS_OPEN_ALERT_WAIT_TIMEOUT_MS = 5_000;

/** How long to wait for the alert to finish dismissing after the accept tap. */
const IOS_OPEN_ALERT_VERIFY_TIMEOUT_MS = 3_000;

const IOS_OPEN_ALERT_POLL_BACKOFF = fixedBackoff(250);

const IOS_OPEN_ALERT_HIERARCHY_TIMEOUT_MS = 2_000;

function collectVisibleHierarchyText(value: unknown, texts: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectVisibleHierarchyText(item, texts);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (VISIBLE_HIERARCHY_TEXT_KEYS.has(key) && typeof child === "string") {
      texts.push(child.trim());
    } else {
      collectVisibleHierarchyText(child, texts);
    }
  }
}

function nodeAttribute(node: Record<string, unknown>, key: string): unknown {
  return node[key] ?? nodeAttributes(node)[key];
}

function countIosDialogButtons(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + countIosDialogButtons(item), 0);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  const node = value as Record<string, unknown>;
  const className = nodeAttribute(node, "className") ?? nodeAttribute(node, "class");
  const role = nodeAttribute(node, "role");
  const ownCount = className === "UIButton" || role === "button" ? 1 : 0;
  return (
    ownCount +
    Object.entries(node).reduce(
      (count, [key, child]) => count + (key === "$" ? 0 : countIosDialogButtons(child)),
      0,
    )
  );
}

function containsIosSystemDialog(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsIosSystemDialog);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const node = value as Record<string, unknown>;
  const className = nodeAttribute(node, "className") ?? nodeAttribute(node, "class");
  if (
    typeof className === "string" &&
    IOS_SYSTEM_DIALOG_CLASSES.has(className) &&
    countIosDialogButtons(node) >= 2
  ) {
    return true;
  }
  return Object.entries(node).some(([key, child]) => key !== "$" && containsIosSystemDialog(child));
}

export function isIosAppOpenAlertHierarchy(
  hierarchy: ObserveResult["viewHierarchy"] | undefined,
): boolean {
  const texts: string[] = [];
  collectVisibleHierarchyText(hierarchy?.hierarchy, texts);
  const hasEnglishOpenLabels =
    texts.some((text) => /^open in .+\?$/i.test(text)) &&
    texts.some((text) => text.toLowerCase() === "open");
  return (
    hasEnglishOpenLabels ||
    (hierarchy?.packageName === "com.apple.springboard" &&
      containsIosSystemDialog(hierarchy.hierarchy))
  );
}

function throwIfOpenAlertAcceptanceAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled");
  }
}

async function refreshOpenAlertHierarchy(
  hierarchy: ObserveResult["viewHierarchy"] | undefined,
  refreshHierarchy: OpenAlertHierarchyRefresh | undefined,
): Promise<ObserveResult["viewHierarchy"] | undefined> {
  return refreshHierarchy ? ((await refreshHierarchy()) ?? hierarchy) : hierarchy;
}

async function tapLiveSystemAlert(tapSystemAlert: SystemAlertTap | undefined): Promise<boolean> {
  return tapSystemAlert ? (await tapSystemAlert()).success : false;
}

interface OpenAlertTiming {
  timer: Timer;
  waitTimeoutMs: number;
  verifyTimeoutMs: number;
}

/** Probe until it yields a value or the budget is spent; the delay between probes is bounded by the backoff. */
async function pollWithin<T>(
  timing: { timer: Timer; timeoutMs: number; signal: AbortSignal | undefined },
  probe: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const startedAt = timing.timer.now();
  for (let attempt = 1; ; attempt += 1) {
    throwIfOpenAlertAcceptanceAborted(timing.signal);
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    const delay = IOS_OPEN_ALERT_POLL_BACKOFF.delayForAttempt(attempt);
    if (timing.timer.now() - startedAt + delay > timing.timeoutMs) {
      return undefined;
    }
    await timing.timer.sleep(delay);
  }
}

async function verifyIosOpenAlertDismissed(
  refreshHierarchy: OpenAlertHierarchyRefresh | undefined,
  tapSystemAlert: SystemAlertTap | undefined,
  signal: AbortSignal | undefined,
  timing: OpenAlertTiming,
): Promise<boolean> {
  if (!refreshHierarchy) {
    return true;
  }
  // The dismissal animation outlives the tap: let it run before the first check.
  await timing.timer.sleep(IOS_OPEN_ALERT_POLL_BACKOFF.delayForAttempt(1));
  const dismissed = await pollWithin(
    { timer: timing.timer, timeoutMs: timing.verifyTimeoutMs, signal },
    async () => {
      const hierarchy = await refreshHierarchy();
      if (!hierarchy) {
        return undefined;
      }
      if (!isIosAppOpenAlertHierarchy(hierarchy)) {
        return true;
      }
      // Re-tap only while the same alert is still on screen. A failed live tap just means the
      // dialog is already leaving, so the next poll decides.
      await tapLiveSystemAlert(tapSystemAlert);
      return undefined;
    },
  );
  return dismissed === true;
}

async function resolveIosOpenAlert(
  initialHierarchy: ObserveResult["viewHierarchy"] | undefined,
  refreshHierarchy: OpenAlertHierarchyRefresh | undefined,
  tapSystemAlert: SystemAlertTap | undefined,
  signal: AbortSignal | undefined,
  timing: OpenAlertTiming,
): Promise<OpenAlertResolution> {
  if (isIosAppOpenAlertHierarchy(initialHierarchy) && !tapSystemAlert) {
    return initialHierarchy ? { hierarchy: initialHierarchy } : null;
  }
  if (!refreshHierarchy && !tapSystemAlert) {
    return null;
  }

  let hierarchy = initialHierarchy;
  const resolved = await pollWithin(
    { timer: timing.timer, timeoutMs: timing.waitTimeoutMs, signal },
    async (): Promise<OpenAlertResolution | undefined> => {
      hierarchy = await refreshOpenAlertHierarchy(hierarchy, refreshHierarchy);
      if (await tapLiveSystemAlert(tapSystemAlert)) {
        return { systemTapped: true };
      }
      if (isIosAppOpenAlertHierarchy(hierarchy)) {
        return hierarchy ? { hierarchy } : null;
      }
      return undefined;
    },
  );
  return resolved ?? null;
}

function systemAlertTapResult(text: string): TapOnElementResult {
  return {
    success: true,
    action: "tap",
    element: { text, bounds: { left: 0, top: 0, right: 0, bottom: 0 } },
  } as TapOnElementResult;
}

/**
 * Tap the system-owned accept button only when the merged SpringBoard hierarchy
 * proves the custom-URL confirmation is present. Waits (bounded) for the alert to
 * appear and to dismiss; returns null when none appeared in the window, and throws an
 * {@link IosOpenAlertError} naming the failed phase otherwise.
 */
export async function acceptIosAppOpenAlert(
  device: BootedDevice,
  observation: ObserveResult | undefined,
  progress?: ProgressCallback,
  signal?: AbortSignal,
  options: AcceptIosAppOpenAlertOptions = {},
): Promise<TapOnElementResult | null> {
  const { refreshHierarchy, tapSystemAlert, tapOnElementFactory } = options;
  if (device.platform !== "ios") {
    return null;
  }
  const timing: OpenAlertTiming = {
    timer: options.timer ?? defaultTimer,
    waitTimeoutMs: options.waitTimeoutMs ?? IOS_OPEN_ALERT_WAIT_TIMEOUT_MS,
    verifyTimeoutMs: options.verifyTimeoutMs ?? IOS_OPEN_ALERT_VERIFY_TIMEOUT_MS,
  };

  const resolution = await resolveIosOpenAlert(
    observation?.viewHierarchy,
    refreshHierarchy,
    tapSystemAlert,
    signal,
    timing,
  );
  if (!resolution) {
    return null;
  }
  const verify = async (candidates: readonly string[]) => {
    if (!(await verifyIosOpenAlertDismissed(refreshHierarchy, tapSystemAlert, signal, timing))) {
      throw new IosOpenAlertError("verify", "dialog remained visible", candidates);
    }
  };
  if ("systemTapped" in resolution) {
    await verify([]);
    return systemAlertTapResult("Open");
  }

  const tapped = await tapAlertAcceptButton(
    device,
    resolution.hierarchy,
    { tapOnElementFactory, tapSystemAlert },
    { progress, signal },
  );
  await verify(tapped.candidates);
  return tapped.result;
}

/** Tap the accept button chosen by role; the live system tap covers a tap that misses. */
async function tapAlertAcceptButton(
  device: BootedDevice,
  hierarchy: ObserveResult["viewHierarchy"],
  taps: Pick<AcceptIosAppOpenAlertOptions, "tapOnElementFactory" | "tapSystemAlert">,
  context: { progress: ProgressCallback | undefined; signal: AbortSignal | undefined },
): Promise<{ result: TapOnElementResult; candidates: string[] }> {
  // Role and position pick the button; the English "Open" label is only the last resort.
  const accept = selectIosOpenAlertAcceptButton(hierarchy);
  const candidates = accept?.candidates ?? [];
  const result = await (taps.tapOnElementFactory ?? defaultTapOnElementFactory)(device).execute(
    { ...(accept?.selector ?? { text: "Open" }), action: "tap" },
    context,
  );
  if (result.success) {
    return { result, candidates };
  }
  if (await tapLiveSystemAlert(taps.tapSystemAlert)) {
    return { result: systemAlertTapResult(candidates.at(-1) ?? "Open"), candidates };
  }
  throw new IosOpenAlertError(
    accept ? "tap" : "detect",
    accept ? result.error || "unknown error" : "the alert offers no accept button",
    candidates,
  );
}

// ============================================================================
// Tool Registration
// ============================================================================

async function handleInstalledImeAction(
  device: BootedDevice,
  args: KeyboardArgs,
  signal?: AbortSignal,
) {
  if (device.platform !== "android") {
    throw new ActionableError("Installed IME actions are Android-only; select an Android device.");
  }
  if (args.action === "tapImeKey") {
    if (!args.imeId || !args.key) {
      throw new ActionableError("tapImeKey requires imeId and key.");
    }
    return createStructuredToolResponse(
      await createInstalledImeKeySession(device).tapKey(args.imeId, args.key, signal),
    );
  }
  const adb = defaultAdbClientFactory.create(device);
  const catalog = new AndroidImeCatalog(adb, device.deviceId, createForegroundUserSource(adb));
  if (args.action === "listImes") {
    return createStructuredToolResponse(await catalog.list(signal));
  }
  if (!args.imeId) {
    throw new ActionableError("keyboard setIme requires imeId from listImes.");
  }
  return createStructuredToolResponse(await catalog.select(args.imeId, signal));
}

// Per-command factories preserve the default device implementations in production.
const defaultKeyboardFactory: NonNullable<InteractionToolDependencies["keyboardFactory"]> = (
  device,
) => new Keyboard(device);

const defaultOpenUrlFactory: NonNullable<InteractionToolDependencies["openUrlFactory"]> = (
  device,
) => new OpenURL(device);

const defaultOpenLinkChooserFactory: NonNullable<
  InteractionToolDependencies["openLinkChooserFactory"]
> = (device) => new HandleIntentChooser(device);

const defaultShakeFactory: NonNullable<InteractionToolDependencies["shakeFactory"]> = (device) =>
  new Shake(device);

const defaultRecentAppsFactory: NonNullable<InteractionToolDependencies["recentAppsFactory"]> = (
  device,
) => new RecentApps(device);

const defaultClipboardFactory: NonNullable<InteractionToolDependencies["clipboardFactory"]> = (
  device,
) => new Clipboard(device);

const defaultWakeAndUnlockFactory: NonNullable<
  InteractionToolDependencies["wakeAndUnlockFactory"]
> = (device) =>
  new WakeAndUnlock(device, undefined, {
    credentialStore: new DeviceLockStore(),
    iosUnlocker: device.platform === "ios" ? new IosLockScreenUnlocker(device) : undefined,
    iosRunnerRecovery:
      device.platform === "ios" ? IOSCtrlProxyClient.getInstance(device) : undefined,
  });

function buildIosOpenAlertOptions(
  iosClient: Pick<
    IosCtrlProxy,
    "requestHierarchySync" | "convertToViewHierarchyResult" | "requestAction"
  > | null,
  signal: AbortSignal | undefined,
  tapOnElementFactory: InteractionToolDependencies["tapOnElementFactory"],
): AcceptIosAppOpenAlertOptions {
  return {
    tapOnElementFactory,
    refreshHierarchy: iosClient
      ? async () => {
          const refreshed = await iosClient.requestHierarchySync(undefined, true, signal, {
            timeoutMs: IOS_OPEN_ALERT_HIERARCHY_TIMEOUT_MS,
          });
          return refreshed ? iosClient.convertToViewHierarchyResult(refreshed.hierarchy) : null;
        }
      : undefined,
    tapSystemAlert: iosClient
      ? () =>
          iosClient.requestAction("system_alert_accept", undefined, undefined, {
            timeoutMs: IOS_OPEN_ALERT_HIERARCHY_TIMEOUT_MS,
            abortSignal: signal,
          })
      : undefined,
  };
}

export const systemTrayHandler = async (
  device: BootedDevice,
  args: SystemTrayArgs,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) => {
  const { payload, isError } = await new SystemTray(device, progress, signal).execute(args);
  const response = createStructuredToolResponse(payload);
  return isError ? { ...response, isError: true as const } : response;
};

export const createSendKeysHandler =
  (deps: InteractionToolDependencies) =>
  async (
    device: BootedDevice,
    args: SendKeysArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    await assertSendKeysRunnerCompatible(device);
    RecompositionTracker.getInstance().recordInteraction(device.deviceId);
    const sendKeys = (deps.sendKeysFactory ?? defaultSendKeysFactory)(device);
    const result = await sendKeys.execute(args.commands, args.selector, {
      progress,
      signal,
      display: args.display,
      focus: {
        container: args.container,
        selectionStrategy: args.selectionStrategy,
        layer: args.layer,
      },
    });
    const dismissal = await dismissKeyboardAfterSendKeys(
      device,
      serverConfig.isDismissKeyboardAfterInputEnabled(),
      result.success,
      {
        close: async (closeSignal) =>
          (deps.keyboardFactory ?? defaultKeyboardFactory)(device).execute("close", {
            signal: closeSignal,
          }),
        signal,
      },
    );
    const response = createStructuredToolResponse({
      message: result.success
        ? `Executed ${result.completedCommands} sendKeys command(s)${dismissal.warnings?.length ? `. Warning: ${dismissal.warnings.join("; ")}` : ""}`
        : `sendKeys stopped at command ${result.failedIndex}: ${result.error}`,
      ...result,
      ...dismissal,
    });
    return result.success ? response : { ...response, isError: true };
  };

export const createWakeAndUnlockHandler =
  (deps: InteractionToolDependencies) =>
  async (
    device: BootedDevice,
    args: WakeAndUnlockArgs,
    _progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    const wakeAndUnlock = (deps.wakeAndUnlockFactory ?? defaultWakeAndUnlockFactory)(device);
    const transportDeadlineMs = (args as Record<string, unknown>)[
      INTERNAL_MCP_REQUEST_DEADLINE_PARAM
    ];
    const result = await wakeAndUnlock.execute(args.pin, {
      deadlineMs: typeof transportDeadlineMs === "number" ? transportDeadlineMs : undefined,
      signal,
    });
    const message = result.success
      ? result.wasLocked
        ? "Device unlocked"
        : "Device awake"
      : `Failed to unlock device: ${result.error ?? "unknown error"}`;
    const response = createStructuredToolResponse({
      message: result.warning ? `${message}. Warning: ${result.warning}` : message,
      ...result,
    });
    return withIsErrorOnFailure(response, result.success);
  };

export const createOpenLinkHandler =
  (deps: InteractionToolDependencies) =>
  async (
    device: BootedDevice,
    args: OpenLinkArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    throwIfAborted(signal);
    // #6154 follow-up: `platform` is optional on the wire, so the schema's
    // iOS-rejects-activityName check (raw request platform) can be skipped
    // entirely when the caller omitted it. Re-validate against the resolved
    // `device.platform` before opening the URL.
    assertActiveWindowWaitForSupportedOnPlatform(
      requireAndroidOrIosPlatform(device.platform, "openLink"),
      args.waitFor,
    );
    if (args.chooserAppPackage && device.platform !== "android") {
      throw new ActionableError("chooserAppPackage is supported only on Android.");
    }

    const openUrl = (deps.openUrlFactory ?? defaultOpenUrlFactory)(device);
    const opened = await openUrl.execute(args.url, { signal });
    throwIfAborted(signal);
    const result = args.chooserAppPackage
      ? await selectAndroidOpenLinkChooser(device, args.chooserAppPackage, opened, {
          url: opened.url,
          chooser: (deps.openLinkChooserFactory ?? defaultOpenLinkChooserFactory)(device),
          signal,
        })
      : opened;
    throwIfAborted(signal);
    const iosClient = device.platform === "ios" ? IOSCtrlProxyClient.getInstance(device) : null;
    const acceptedOpenAlert =
      args.acceptOpenAlert && result.success
        ? await acceptIosAppOpenAlert(
            device,
            result.observation,
            progress,
            signal,
            buildIosOpenAlertOptions(iosClient, signal, deps.tapOnElementFactory),
          )
        : null;
    const effectiveResult: OpenURLResult & { openAlertAccepted?: true } = acceptedOpenAlert
      ? {
          ...result,
          observation: acceptedOpenAlert.observation ?? result.observation,
          openAlertAccepted: true,
        }
      : result;

    // Integrated waitFor (issue #3490 §5): once the URL is opened, poll for the
    // predicate exactly as `observe` does, surfacing the awaited observation and
    // await metadata so callers no longer need a separate observe round-trip.
    const waitOutcome = args.waitFor
      ? await waitForObservation(
          new RealObserveScreen(device),
          { ...args.waitFor, settled: args.settled },
          {
            signal,
            platform: device.platform,
            displayInventory: displayWaitInventory(device)[0],
            displayPanels: displayWaitInventory(device)[1],
          },
        )
      : null;

    const response = createStructuredToolResponse(
      buildOpenLinkPayload(args.url, effectiveResult, waitOutcome),
    );
    return withIsErrorOnFailure(response, effectiveResult.success);
  };

export const createShakeHandler =
  (deps: InteractionToolDependencies) =>
  async (
    device: BootedDevice,
    args: ShakeArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    try {
      const shake = (deps.shakeFactory ?? defaultShakeFactory)(device);
      const result = await shake.execute(
        {
          duration: args.duration ?? 1000,
          intensity: args.intensity ?? 100,
        },
        { progress, signal },
      );

      const response = createStructuredToolResponse({
        message: result.success
          ? `Shook device for ${args.duration ?? 1000}ms with intensity ${args.intensity ?? 100}`
          : `Failed to shake device: ${result.error ?? "unknown error"}`,
        observation: result.observation,
        ...result,
      });
      return withIsErrorOnFailure(response, result.success);
    } catch (error) {
      throw toActionableError(error, `Failed to shake device`);
    }
  };

/** `keyboard setProfile`, admitted and tracked against the session's device when one is named. */
function setKeyboardProfileInSession(
  device: BootedDevice,
  args: KeyboardArgs,
  deps: InteractionToolDependencies,
  signal?: AbortSignal,
) {
  const profileDeps = deps.keyboardProfile ?? {};
  const sessionManager =
    args.sessionUuid && device.platform === "android"
      ? (profileDeps.sessionManager ?? (() => defaultDaemonContext.sessionManager()))()
      : undefined;
  return runSessionKeyboardProfileMutation(
    sessionManager,
    args.sessionUuid,
    device.deviceId,
    (owner) =>
      setKeyboardProfileForTool(device, args.profile, profileDeps.clientFor?.(device), signal, {
        owner,
        registry: profileDeps.registry,
      }),
  );
}

export const createKeyboardHandler =
  (deps: InteractionToolDependencies) =>
  async (
    device: BootedDevice,
    args: KeyboardArgs,
    _progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    try {
      throwIfAborted(signal);
      if (args.action === "setProfile") {
        return createStructuredToolResponse(
          await setKeyboardProfileInSession(device, args, deps, signal),
        );
      }
      if (args.action === "listProfiles") {
        return createStructuredToolResponse(
          await listKeyboardProfilesForTool(device, undefined, signal),
        );
      }
      if (args.action === "listImes" || args.action === "setIme" || args.action === "tapImeKey") {
        return handleInstalledImeAction(device, args, signal);
      }
      throwIfAborted(signal);
      const keyboard = (deps.keyboardFactory ?? defaultKeyboardFactory)(device);
      const result = await keyboard.execute(args.action, { signal });
      throwIfAborted(signal);

      const response = createStructuredToolResponse(result);
      return withIsErrorOnFailure(response, result.success);
    } catch (error) {
      // A click/tap already sent when the abort landed is indeterminate; keep that
      // warning instead of reporting a plain cancellation.
      if (!(error instanceof KeyboardOpenIndeterminateError)) {
        throwIfAborted(signal);
      }
      throw toActionableError(error, `Failed to execute keyboard ${args.action}`);
    }
  };

export const createRecentAppsHandler =
  (deps: InteractionToolDependencies) =>
  async (
    device: BootedDevice,
    args: RecentAppsArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    try {
      const recentApps = (deps.recentAppsFactory ?? defaultRecentAppsFactory)(device);
      const result = await recentApps.execute({ progress, signal });

      const response = createStructuredToolResponse({
        message: formatRecentAppsMessage(result),
        observation: result.observation,
        ...result,
      });
      return result.success ? response : { ...response, isError: true as const };
    } catch (error) {
      throw toActionableError(error, `Failed to open recent apps`);
    }
  };

export const homeScreenHandler = async (
  device: BootedDevice,
  args: any,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) => {
  try {
    throwIfAborted(signal);
    const homeScreen = new HomeScreen(device);
    const result = await homeScreen.execute({ progress, signal });

    const response = createStructuredToolResponse({
      message: "Pressed home button to return to the home screen",
      observation: result.observation,
      ...result,
    });
    return withIsErrorOnFailure(response, result.success);
  } catch (error) {
    throwIfAborted(signal);
    throw toActionableError(error, `Failed to go to home screen`);
  }
};

export const createClipboardHandler =
  (deps: InteractionToolDependencies) =>
  async (
    device: BootedDevice,
    args: ClipboardArgs,
    _progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    try {
      const clipboard = (deps.clipboardFactory ?? defaultClipboardFactory)(device);
      const result = await clipboard.execute(args.action, args.text, { signal });

      let message = formatClipboardMessage(result);

      if (result.method) {
        message += ` (via ${result.method})`;
      }

      const response = createStructuredToolResponse({
        message,
        ...result,
      });
      return result.success ? response : { ...response, isError: true as const };
    } catch (error) {
      throw toActionableError(error, `Failed to execute clipboard ${args.action}`);
    }
  };
