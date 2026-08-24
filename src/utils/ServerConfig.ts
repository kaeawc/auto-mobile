import type { AccessibilityAuditConfig } from "../models/AccessibilityAudit";
import type {
  VideoRecordingConfigInput,
  DeviceSnapshotConfigInput,
  AppearanceConfigInput,
} from "../models";
import {
  DEFAULT_RUNNER_READINESS_TIMEOUT_MS,
  parseRunnerReadinessTimeout,
} from "./runnerReadinessConfig";

export type PlanExecutionLockScope = "session" | "global";

/**
 * Global server configuration state
 * Set once during server initialization
 */
class ServerConfig {
  private static instance: ServerConfig;
  private _uiPerfModeEnabled: boolean = true;
  private _accessibilityAuditConfig: AccessibilityAuditConfig | null = null;
  private _memPerfAuditEnabled: boolean = false;
  private _predictiveUiEnabled: boolean = false;
  private _rawElementSearchEnabled: boolean = false;
  private _planExecutionLockScope: PlanExecutionLockScope = "session";
  private _videoRecordingDefaults: VideoRecordingConfigInput = {};
  private _deviceSnapshotDefaults: DeviceSnapshotConfigInput = {};
  private _appearanceDefaults: AppearanceConfigInput = {};
  private _skipCtrlProxyDownload: boolean = false;
  private _embeddedSdkEnabled: boolean = false;
  private _networkMockableEnabled: boolean = false;
  private _mcpRecordingEnabled: boolean = false;
  private _dismissKeyboardAfterInputEnabled: boolean = false;
  private _eventAllMarkers: string[] = [];
  private _navigationScreenshotsEnabled: boolean = true;
  private _waitForPollingOverheadEnabled: boolean = true;
  private _a11yIncludeNotImportantViews: boolean = true;
  private _a11yReportViewIds: boolean = true;
  private _a11yRetrieveInteractiveWindows: boolean = true;
  private _occlusionEnabled: boolean = true;
  private _planExecutionActive: boolean = false;
  private _observeResultIncludeElements: boolean = false;
  private _toolResultsNoStructuredContent: boolean = false;
  private _actionsDiffObserve: boolean = false;
  private _actionsNoObserve: boolean = false;
  private _toolOutputsDir: string | undefined;
  private _runnerReadinessTimeoutMs = DEFAULT_RUNNER_READINESS_TIMEOUT_MS;

  private constructor() {}

  static getInstance(): ServerConfig {
    if (!ServerConfig.instance) {
      ServerConfig.instance = new ServerConfig();
    }
    return ServerConfig.instance;
  }

  setUiPerfMode(enabled: boolean): void {
    this._uiPerfModeEnabled = enabled;
  }

  isUiPerfModeEnabled(): boolean {
    return this._uiPerfModeEnabled;
  }

  setAccessibilityAuditConfig(config: AccessibilityAuditConfig | null): void {
    this._accessibilityAuditConfig = config;
  }

  getAccessibilityAuditConfig(): AccessibilityAuditConfig | null {
    return this._accessibilityAuditConfig;
  }

  isAccessibilityAuditEnabled(): boolean {
    return this._accessibilityAuditConfig !== null;
  }

  setMemPerfAuditMode(enabled: boolean): void {
    this._memPerfAuditEnabled = enabled;
  }

  isMemPerfAuditEnabled(): boolean {
    return this._memPerfAuditEnabled;
  }

  setPredictiveUiEnabled(enabled: boolean): void {
    this._predictiveUiEnabled = enabled;
  }

  isPredictiveUiEnabled(): boolean {
    return this._predictiveUiEnabled;
  }

  setRawElementSearchEnabled(enabled: boolean): void {
    this._rawElementSearchEnabled = enabled;
  }

  isRawElementSearchEnabled(): boolean {
    return this._rawElementSearchEnabled;
  }

  setPlanExecutionLockScope(scope: PlanExecutionLockScope): void {
    this._planExecutionLockScope = scope;
  }

  getPlanExecutionLockScope(): PlanExecutionLockScope {
    return this._planExecutionLockScope;
  }

  setVideoRecordingDefaults(defaults: VideoRecordingConfigInput): void {
    this._videoRecordingDefaults = { ...defaults };
  }

  getVideoRecordingDefaults(): VideoRecordingConfigInput {
    return { ...this._videoRecordingDefaults };
  }

  setDeviceSnapshotDefaults(defaults: DeviceSnapshotConfigInput): void {
    this._deviceSnapshotDefaults = { ...defaults };
  }

  getDeviceSnapshotDefaults(): DeviceSnapshotConfigInput {
    return { ...this._deviceSnapshotDefaults };
  }

  setAppearanceDefaults(defaults: AppearanceConfigInput): void {
    this._appearanceDefaults = { ...defaults };
  }

  getAppearanceDefaults(): AppearanceConfigInput {
    return { ...this._appearanceDefaults };
  }

  setToolOutputsDir(dir: string | undefined): void {
    this._toolOutputsDir = dir;
  }

  getToolOutputsDir(): string | undefined {
    return this._toolOutputsDir;
  }

  isToolOutputArtifactModeEnabled(): boolean {
    return this._toolOutputsDir !== undefined;
  }

  setSkipCtrlProxyDownload(skip: boolean): void {
    this._skipCtrlProxyDownload = skip;
  }

  isSkipCtrlProxyDownloadEnabled(): boolean {
    return this._skipCtrlProxyDownload;
  }

  setRunnerReadinessTimeoutMs(timeoutMs: number): void {
    const parsed = parseRunnerReadinessTimeout(timeoutMs);
    if (parsed === undefined) {
      throw new RangeError(`Invalid runner readiness timeout: ${timeoutMs}`);
    }
    this._runnerReadinessTimeoutMs = parsed;
  }

  getRunnerReadinessTimeoutMs(): number {
    return this._runnerReadinessTimeoutMs;
  }

  setEmbeddedSdkEnabled(enabled: boolean): void {
    this._embeddedSdkEnabled = enabled;
  }

  isEmbeddedSdkEnabled(): boolean {
    return this._embeddedSdkEnabled;
  }

  setNetworkMockableEnabled(enabled: boolean): void {
    this._networkMockableEnabled = enabled;
  }

  isNetworkMockableEnabled(): boolean {
    return this._networkMockableEnabled;
  }

  setMcpRecordingEnabled(enabled: boolean): void {
    this._mcpRecordingEnabled = enabled;
  }

  isMcpRecordingEnabled(): boolean {
    return this._mcpRecordingEnabled;
  }

  setDismissKeyboardAfterInputEnabled(enabled: boolean): void {
    this._dismissKeyboardAfterInputEnabled = enabled;
  }

  isDismissKeyboardAfterInputEnabled(): boolean {
    return this._dismissKeyboardAfterInputEnabled;
  }

  /**
   * Markers that, when present in inputText's text, auto-promote the call from
   * the default `a11y` mode to `eventAll` (real per-character key events). An
   * empty list (the default) disables the behavior entirely.
   */
  setEventAllMarkers(markers: readonly string[]): void {
    this._eventAllMarkers = [...markers];
  }

  getEventAllMarkers(): readonly string[] {
    return this._eventAllMarkers;
  }

  setNavigationScreenshotsEnabled(enabled: boolean): void {
    this._navigationScreenshotsEnabled = enabled;
  }

  isNavigationScreenshotsEnabled(): boolean {
    return this._navigationScreenshotsEnabled;
  }

  setWaitForPollingOverheadEnabled(enabled: boolean): void {
    this._waitForPollingOverheadEnabled = enabled;
  }

  isWaitForPollingOverheadEnabled(): boolean {
    return this._waitForPollingOverheadEnabled;
  }

  setA11yIncludeNotImportantViews(enabled: boolean): void {
    this._a11yIncludeNotImportantViews = enabled;
  }

  setA11yReportViewIds(enabled: boolean): void {
    this._a11yReportViewIds = enabled;
  }

  setA11yRetrieveInteractiveWindows(enabled: boolean): void {
    this._a11yRetrieveInteractiveWindows = enabled;
  }

  setOcclusionEnabled(enabled: boolean): void {
    this._occlusionEnabled = enabled;
  }

  getAccessibilityFlagsConfig(): {
    includeNotImportantViews: boolean;
    reportViewIds: boolean;
    retrieveInteractiveWindows: boolean;
    occlusionEnabled: boolean;
  } {
    return {
      includeNotImportantViews: this._a11yIncludeNotImportantViews,
      reportViewIds: this._a11yReportViewIds,
      retrieveInteractiveWindows: this._a11yRetrieveInteractiveWindows,
      occlusionEnabled: this._occlusionEnabled,
    };
  }

  setPlanExecutionActive(active: boolean): void {
    this._planExecutionActive = active;
  }

  isPlanExecutionActive(): boolean {
    return this._planExecutionActive;
  }

  // --- Output-size reduction flags (issue #2756) ---
  //
  // Compact bounds tuples, the skeleton projection, compact JSON, and the
  // focus/overview/region observe-scope gates are now unconditional defaults, so
  // they no longer carry a toggle here. `observe-result-include-elements` is the
  // sole survivor of the observe-shape flags: the flattened `elements` array is
  // dropped by default, and this opt-in restores it.

  setObserveResultIncludeElementsEnabled(enabled: boolean): void {
    this._observeResultIncludeElements = enabled;
  }

  isObserveResultIncludeElementsEnabled(): boolean {
    return this._observeResultIncludeElements;
  }

  setToolResultsNoStructuredContentEnabled(enabled: boolean): void {
    this._toolResultsNoStructuredContent = enabled;
  }

  isToolResultsNoStructuredContentEnabled(): boolean {
    return this._toolResultsNoStructuredContent;
  }

  setActionsDiffObserveEnabled(enabled: boolean): void {
    this._actionsDiffObserve = enabled;
  }

  isActionsDiffObserveEnabled(): boolean {
    return this._actionsDiffObserve;
  }

  setActionsNoObserveEnabled(enabled: boolean): void {
    this._actionsNoObserve = enabled;
  }

  isActionsNoObserveEnabled(): boolean {
    return this._actionsNoObserve;
  }
}

export const serverConfig = ServerConfig.getInstance();
