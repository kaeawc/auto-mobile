/**
 * Shared types for CtrlProxyClient delegates.
 *
 * This module defines the context interfaces that delegates receive to access
 * shared state and functionality from the main CtrlProxyClient.
 */

import type {
  BootedDevice,
  ContentHiddenRegion,
  RecompositionNodeInfo,
  ViewHierarchyWindowInfo
} from "../../../models";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type {
  PerfTiming,
  BaseResult,
  GestureTimingResult,
  ActionTimingResult,
  DelegateContext,
} from "../shared/types";
import type { ObservationInsets } from "../../../models/ObservationInsets";
import type { ScreenshotPerformanceMetadata } from "../ScreenshotMetadata";

// Re-export shared types so existing imports from "./types" continue to work
export type { DelegateContext } from "../shared/types";

/**
 * Generate a secure ID for request IDs.
 */
export function generateSecureId(): string {
  const { randomBytes } = require("crypto");
  return randomBytes(4).toString("hex");
}

/**
 * Quote a string for use in ADB shell arguments.
 */
export const quoteForAdbArg = (value: string): string => {
  const escaped = value.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
  return `"${escaped}"`;
};

/**
 * Interface for accessibility service node format
 */
export interface AccessibilityNode {
  text?: string;
  "content-desc"?: string;
  "resource-id"?: string;
  "view-id"?: string;
  "test-tag"?: string;
  "unique-id"?: string;
  "collection-row-index"?: number;
  "collection-column-index"?: number;
  "visible-to-user"?: boolean;
  "container-title"?: string;
  className?: string;
  packageName?: string;
  bounds?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  clickable?: string;
  enabled?: string;
  focusable?: string;
  focused?: string;
  scrollable?: string;
  password?: string;
  checkable?: string;
  checked?: string;
  selected?: string;
  "long-clickable"?: string;
  occlusionState?: string;
  occludedBy?: string;
  occludedByViewId?: string;
  extras?: Record<string, string>;
  recomposition?: RecompositionNodeInfo;
  node?: AccessibilityNode | AccessibilityNode[];
}

/**
 * Stable fields observed from an accessibility node that can identify it for a semantic action.
 * All populated fields must match the target node.
 */
export interface AccessibilityNodeSelector {
  resourceId?: string;
  testTag?: string;
  uniqueId?: string;
  collectionRow?: number;
  collectionColumn?: number;
}

/**
 * Interface for accessibility hierarchy data from the device.
 */
export interface AccessibilityHierarchy {
  updatedAt: number;
  packageName: string;
  hierarchy: AccessibilityNode;
  windows?: ViewHierarchyWindowInfo[];
  contentHiddenRegions?: ContentHiddenRegion[];
  intentChooserDetected?: boolean;
  notificationPermissionDetected?: boolean;
  /** Element with TalkBack cursor */
  "accessibility-focused-element"?: AccessibilityNode;
  /**
   * True when CtrlProxy couldn't fully extract the hierarchy.
   * This happens when the active window has a null root (app restricts accessibility)
   * or only system UI windows were accessible.
   */
  ctrlProxyIncomplete?: boolean;
  error?: string;
  /** Screen width from accessibility service (eliminates need for dumpsys) */
  screenWidth?: number;
  /** Screen height from accessibility service (eliminates need for dumpsys) */
  screenHeight?: number;
  /** Display rotation: 0=portrait, 1=landscape90, 2=reverse, 3=landscape270 */
  rotation?: number;
  /** System insets (status bar, nav bar, gesture insets) */
  systemInsets?: { top: number; bottom: number; left: number; right: number };
  insets?: ObservationInsets;
  /** Device wakefulness: "Awake", "Asleep", or "Dozing" */
  wakefulness?: "Awake" | "Asleep" | "Dozing";
  /** Foreground activity component name, e.g. "com.example.app/.MainActivity" */
  foregroundActivity?: string;
  /** Display density in DPI */
  density?: number;
  /** Android API level (e.g. 34) */
  sdkInt?: number;
  /** Device model (e.g. "Pixel 8") */
  deviceModel?: string;
  /** Whether running on an emulator */
  isEmulator?: boolean;
  /** Structured reasons why this snapshot is partial or unavailable. */
  truncationReasons?: string[];
  /**
   * Bounds->screenshot-pixel ratio (#4548, additive; absent from pre-#4548 runners). Android
   * bounds and screenshots are both physical pixels, so the runner reports exactly 1. The runner
   * serializes absent optionals as JSON null (`encodeDefaults = true`), hence `| null`.
   */
  nativeScale?: number | null;
  /** Physical screenshot pixel width (== screenWidth on Android) (#4548, additive). */
  pixelWidth?: number | null;
  /** Physical screenshot pixel height (== screenHeight on Android) (#4548, additive). */
  pixelHeight?: number | null;
}

/**
 * Android-side performance timing data.
 * Alias for shared PerfTiming type.
 */
export type AndroidPerfTiming = PerfTiming;

/**
 * Per-call diagnostics out-parameter for `CtrlProxyHierarchy.requestHierarchySync` (issue #3062).
 *
 * `requestHierarchySync` returns `null` on BOTH a plain timeout (the runner never pushed a
 * hierarchy) and a correlated runner `type:"error"` frame (#3032 / #3061 fail the wait fast).
 * The two are indistinguishable from the return value alone. Callers that care can pass a fresh
 * `{}` and inspect `runnerError` afterward: it is populated with the runner's structured error
 * text ONLY on the runner-error path, and left `undefined` on timeout or success. Passing no
 * object preserves the original behavior — this is a purely additive, per-call channel with no
 * shared state (so concurrent syncs cannot misattribute one another's errors).
 */
export interface HierarchySyncDiagnostics {
  /** The runner's structured error text when the sync failed fast on a correlated runner
   *  `type:"error"` frame; `undefined` on a plain timeout or a successful sync. */
  runnerError?: string;
}

/**
 * Interface for cached hierarchy with metadata
 */
export interface CachedHierarchy {
  hierarchy: AccessibilityHierarchy;
  receivedAt: number;
  fresh: boolean;
  perfTiming?: AndroidPerfTiming[];
  frameContext?: string;
}

/**
 * Interface for hierarchy response with freshness indicator
 */
export interface AccessibilityHierarchyResponse {
  hierarchy: AccessibilityHierarchy | null;
  fresh: boolean;
  updatedAt?: number; // Timestamp from device (only present when hierarchy data exists)
  receivedAt?: number; // Host-clock-domain receipt time; basis for host-domain age (issue #5377)
  perfTiming?: AndroidPerfTiming[]; // Android-side performance timing data
  frameContext?: string;
}

/**
 * Interface for screenshot result
 */
export interface ScreenshotResult extends ScreenshotPerformanceMetadata {
  success: boolean;
  data?: string; // Base64 encoded JPEG
  format?: string;
  timestamp?: number;
  rotation?: number;
  error?: string;
  frameContext?: string;
}

/** Swipe result from accessibility service */
export type A11ySwipeResult = GestureTimingResult;

/** Tap coordinates result from accessibility service */
export type A11yTapCoordinatesResult = BaseResult;

/** Drag result from accessibility service */
export type A11yDragResult = GestureTimingResult;

/** Pinch result from accessibility service */
export type A11yPinchResult = GestureTimingResult;

/** Set text result from accessibility service */
export type A11ySetTextResult = BaseResult;

/** IME action result from accessibility service */
export type A11yImeActionResult = ActionTimingResult;

/** Select all result from accessibility service */
export type A11ySelectAllResult = BaseResult;

/** Accessibility action result */
export type A11yActionResult = ActionTimingResult;

/** Clipboard operation result from accessibility service */
export interface A11yClipboardResult extends BaseResult {
  action: "copy" | "paste" | "clear" | "get";
  text?: string; // For 'get' action, the clipboard content
}

/** Settings.System/Secure/Global namespace */
export type SettingsNamespace = "system" | "secure" | "global";

/** Settings value type for writes */
export type SettingsValueType = "string" | "int" | "long" | "float";

/** Result of a settings read via accessibility service */
export interface A11ySettingsGetResult extends BaseResult {
  value?: string;
  found: boolean;
}

/** Result of a settings write via accessibility service */
export type A11ySettingsPutResult = BaseResult;

/** Result of a settings list via accessibility service */
export interface A11ySettingsListResult extends BaseResult {
  entries?: Record<string, string>;
}

/** CA certificate result from accessibility service */
export interface A11yCaCertResult extends BaseResult {
  action: "install" | "remove";
  alias?: string;
}

/** Device owner status result from accessibility service */
export interface A11yDeviceOwnerStatusResult extends BaseResult {
  isDeviceOwner: boolean;
  isAdminActive: boolean;
  packageName?: string;
}

/** Permission status result from accessibility service */
export interface A11yPermissionResult extends BaseResult {
  permission: string;
  granted: boolean;
  requestLaunched: boolean;
  canRequest: boolean;
  requiresSettings: boolean;
  instructions?: string;
  adbCommand?: string;
}

export interface InstalledPackageRecord {
  packageName: string;
  isSystem: boolean;
  versionName?: string;
  versionCode?: number;
}

export interface A11yInstalledPackagesResult extends BaseResult {
  userId: number;
  packages: InstalledPackageRecord[];
}

export interface A11yPackageInfoResult extends BaseResult {
  packageName: string;
  isSystem: boolean;
  applicationLabel?: string;
  versionName?: string;
  versionCode?: number;
  installerPackage?: string;
  firstInstallTime?: number;
  lastUpdateTime?: number;
  allowBackup?: boolean;
  requestedPermissions: string[];
  grantedPermissions: Record<string, boolean>;
  mainActivity?: string;
}

export interface A11yLaunchIntentResult extends BaseResult {
  packageName: string;
  componentName?: string;
}

/**
 * Extended context for hierarchy delegate with additional state access.
 */
export interface HierarchyDelegateContext extends DelegateContext {
  /** The device this client is connected to */
  device: BootedDevice;
  /** ADB executor for running device commands */
  adb: AdbExecutor;
  /** Get the cached hierarchy data */
  getCachedHierarchy(): CachedHierarchy | null;
  /** Set the cached hierarchy data */
  setCachedHierarchy(h: CachedHierarchy | null): void;
  /** Get the timestamp of the last WebSocket timeout */
  getLastWebSocketTimeout(): number;
  /** Set the timestamp of the last WebSocket timeout */
  setLastWebSocketTimeout(time: number): void;
}

/**
 * Extended context for certificates delegate with ADB access.
 */
export interface CertificatesDelegateContext extends DelegateContext {
  /** ADB executor for running device commands */
  adb: AdbExecutor;
}

/**
 * Interface for highlight shape bounds normalization
 */
export interface NormalizedHighlightBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  sourceWidth?: number | null;
  sourceHeight?: number | null;
}
