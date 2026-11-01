import type { AdvancePrototypeClockMessage } from "./prototypeMessages";
/** Typed request builders and millisecond normalization for byte-identical wire frames. */
import type { PrototypePatchRequest } from "../../../prototype/prototypePatchWire";
import type { PrototypeSpec } from "../../../prototype/prototypeSpec";
import { clearPrototypeStorageMessage } from "../../../prototype/prototypeStorageWire";
import type { HighlightShape } from "../../../../models/VisualHighlight";
import type { NetworkMockRuleSync } from "../../../../utils/networkMockRules";
import type { KeyValueType } from "../../../storage/storageTypes";
import type { SettingsNamespace, SettingsValueType } from "../types";
import type {
  RequestHierarchyMessage,
  RequestHierarchyIfStaleMessage,
  SetHierarchyIntervalMessage,
  RequestScreenshotMessage,
  RequestActionMessage,
  RequestClickFocusedInputMessage,
  RequestActivateAccessibilityLinkMessage,
  RequestClipboardMessage,
  RequestSettingsGetMessage,
  RequestSettingsPutMessage,
  RequestSettingsListMessage,
  InstallCaCertMessage,
  InstallCaCertFromPathMessage,
  RemoveCaCertMessage,
  GetDeviceOwnerStatusMessage,
  GetPermissionMessage,
  RequestDeviceInfoMessage,
  GetCurrentFocusMessage,
  GetTraversalOrderMessage,
  AddHighlightMessage,
  ListPreferenceFilesMessage,
  GetPreferencesMessage,
  DiscoverKeystoreMessage,
  ResetKeystoreMessage,
  GetSdkCapabilitiesMessage,
  ListDataStoresMessage,
  GetDataStoreMessage,
  SubscribeStorageMessage,
  UnsubscribeStorageMessage,
  GetPreferenceMessage,
  SetPreferenceMessage,
  RemovePreferenceMessage,
  ClearPreferencesMessage,
  RequestGlobalActionMessage,
  ValidateFrameContextMessage,
  SetRecompositionTrackingMessage,
  SetAccessibilityFlagsMessage,
  SetNetworkMockRulesMessage,
  SetNetworkErrorSimulationMessage,
  RequestInstalledPackagesMessage,
  RequestPackageInfoMessage,
  RequestLaunchIntentMessage,
  StartRecordingMessage,
  StopRecordingMessage,
  CtrlProxyRequest,
} from "./requestMessages";
import type {
  ShowPrototypeMessage,
  PrototypeAppearanceOverride,
  PrototypeDismiss,
  DismissPrototypeMessage,
  PatchPrototypeMessage,
  SavePrototypeMessage,
  ListSavedPrototypesMessage,
  DeleteSavedPrototypeMessage,
  PinSavedPrototypeMessage,
  InspectPrototypesMessage,
  PutPrototypeAssetMessage,
  RemovePrototypeAssetMessage,
} from "./prototypeMessages";

// =============================================================================
// Serialization
// =============================================================================

const STROKE_DURATION_FIELDS = new Map<string, readonly string[]>([
  ["request_tap_coordinates", ["duration"]],
  ["request_swipe", ["duration"]],
  ["request_two_finger_swipe", ["duration"]],
  ["request_pinch", ["duration"]],
]);

const MILLISECOND_FIELDS = new Map<string, readonly string[]>([
  ["request_drag", ["pressDurationMs", "dragDurationMs", "holdDurationMs", "holdTime", "duration"]],
  ["set_hierarchy_interval", ["intervalMs"]],
]);

/**
 * Android's Long fields reject decimal JSON tokens; StrokeDescription also requires duration > 0.
 * Drag phases and hierarchy intervals retain meaningful zeros. Leave other numbers untouched.
 */
export function normalizeCtrlProxyMilliseconds(
  type: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const strokeFields = STROKE_DURATION_FIELDS.get(type);
  const fields = strokeFields ?? MILLISECOND_FIELDS.get(type);
  if (!fields) {
    return params;
  }
  return Object.fromEntries(
    Object.entries(params).map(([field, value]) => [
      field,
      fields.includes(field) && typeof value === "number"
        ? strokeFields !== undefined || value > 0
          ? Math.max(1, Math.round(value))
          : Math.round(value)
        : value,
    ]),
  );
}

/**
 * Serialize typed Android requests with the gesture delegate's duration policy.
 * JSON.stringify omits undefined fields and preserves explicit nulls.
 */
export function serializeCtrlProxyRequest(request: CtrlProxyRequest): string {
  return JSON.stringify(normalizeCtrlProxyMilliseconds(request.type, { ...request }));
}

// =============================================================================
// Builders
// =============================================================================

/**
 * Typed builders for Android control-proxy requests. Delegates that route through the shared
 * `sendCommand` path pass the equivalent params and tests pin their frames against these builders;
 * the remaining direct send sites serialize them with {@link serializeCtrlProxyRequest}.
 * Each returns the {@link CtrlProxyRequest} union member for its command. Field order matches
 * the pre-migration send sites so the serialized output is byte-identical.
 *
 * Gesture/text commands are absent by design — see the module doc comment (they go through the
 * shared cross-platform path).
 */
export const ctrlProxyRequests = {
  requestHierarchy(args: {
    requestId: string;
    displayId?: number;
    disableAllFiltering: boolean;
    maxDepth?: number;
    maxNodes?: number;
  }): RequestHierarchyMessage {
    return {
      type: "request_hierarchy",
      requestId: args.requestId,
      ...(args.displayId === undefined ? {} : { displayId: args.displayId }),
      disableAllFiltering: args.disableAllFiltering,
      maxDepth: args.maxDepth,
      maxNodes: args.maxNodes,
    };
  },

  requestHierarchyIfStale(args: {
    requestId: string;
    sinceTimestamp: number;
  }): RequestHierarchyIfStaleMessage {
    return {
      type: "request_hierarchy_if_stale",
      requestId: args.requestId,
      sinceTimestamp: args.sinceTimestamp,
    };
  },

  setHierarchyInterval(args: { intervalMs: number | null }): SetHierarchyIntervalMessage {
    return { type: "set_hierarchy_interval", intervalMs: args.intervalMs };
  },

  requestScreenshot(args: {
    requestId: string;
    displayId?: number;
    hidePrototypes?: boolean;
  }): RequestScreenshotMessage {
    return {
      type: "request_screenshot",
      requestId: args.requestId,
      ...(args.displayId === undefined ? {} : { displayId: args.displayId }),
      ...(args.hidePrototypes === true ? { hidePrototypes: true } : {}),
    };
  },

  requestClickFocusedInput(args: { requestId: string }): RequestClickFocusedInputMessage {
    return { type: "request_click_focused_input", requestId: args.requestId };
  },

  requestAction(args: {
    requestId: string;
    action: string;
    resourceId?: string;
    selector?: RequestActionMessage["selector"];
    customAction?: string;
    progress?: number;
  }): RequestActionMessage {
    return {
      type: "request_action",
      requestId: args.requestId,
      action: args.action,
      resourceId: args.resourceId,
      selector: args.selector,
      ...(args.customAction !== undefined ? { customAction: args.customAction } : {}),
      ...(args.progress !== undefined ? { progress: args.progress } : {}),
    };
  },

  requestActivateAccessibilityLink(args: {
    requestId: string;
    text: string;
    occurrence: number;
    selector?: RequestActionMessage["selector"];
  }): RequestActivateAccessibilityLinkMessage {
    return {
      type: "request_activate_accessibility_link",
      requestId: args.requestId,
      text: args.text,
      occurrence: args.occurrence,
      selector: args.selector,
    };
  },

  requestClipboard(args: {
    requestId: string;
    action: "copy" | "paste" | "clear" | "get";
    text?: string;
  }): RequestClipboardMessage {
    return {
      type: "request_clipboard",
      requestId: args.requestId,
      action: args.action,
      text: args.text,
    };
  },

  requestSettingsGet(args: {
    requestId: string;
    namespace: SettingsNamespace;
    key: string;
  }): RequestSettingsGetMessage {
    return {
      type: "request_settings_get",
      requestId: args.requestId,
      namespace: args.namespace,
      key: args.key,
    };
  },

  requestSettingsPut(args: {
    requestId: string;
    namespace: SettingsNamespace;
    key: string;
    value: string | null;
    valueType: SettingsValueType;
  }): RequestSettingsPutMessage {
    return {
      type: "request_settings_put",
      requestId: args.requestId,
      namespace: args.namespace,
      key: args.key,
      value: args.value,
      valueType: args.valueType,
    };
  },

  requestSettingsList(args: {
    requestId: string;
    namespace: SettingsNamespace;
  }): RequestSettingsListMessage {
    return { type: "request_settings_list", requestId: args.requestId, namespace: args.namespace };
  },

  installCaCert(args: { requestId: string; certificate: string }): InstallCaCertMessage {
    return { type: "install_ca_cert", requestId: args.requestId, certificate: args.certificate };
  },

  installCaCertFromPath(args: {
    requestId: string;
    devicePath: string;
  }): InstallCaCertFromPathMessage {
    return {
      type: "install_ca_cert_from_path",
      requestId: args.requestId,
      devicePath: args.devicePath,
    };
  },

  removeCaCert(args: { requestId: string; alias: string }): RemoveCaCertMessage {
    return { type: "remove_ca_cert", requestId: args.requestId, alias: args.alias };
  },

  getDeviceOwnerStatus(args: { requestId: string }): GetDeviceOwnerStatusMessage {
    return { type: "get_device_owner_status", requestId: args.requestId };
  },

  getPermission(args: {
    requestId: string;
    permission: string;
    requestPermission: boolean;
  }): GetPermissionMessage {
    return {
      type: "get_permission",
      requestId: args.requestId,
      permission: args.permission,
      requestPermission: args.requestPermission,
    };
  },

  requestDeviceInfo(args: { requestId: string }): RequestDeviceInfoMessage {
    return { type: "request_device_info", requestId: args.requestId };
  },

  getCurrentFocus(args: { requestId: string }): GetCurrentFocusMessage {
    return { type: "get_current_focus", requestId: args.requestId };
  },

  getTraversalOrder(args: { requestId: string }): GetTraversalOrderMessage {
    return { type: "get_traversal_order", requestId: args.requestId };
  },

  showPrototype(args: {
    requestId: string;
    spec: PrototypeSpec;
    displayId?: number;
    reset?: boolean;
    replaceOthers?: boolean;
    appearance?: PrototypeAppearanceOverride;
    locale?: string;
  }): ShowPrototypeMessage {
    return {
      type: "show_prototype",
      requestId: args.requestId,
      spec: args.spec,
      ...(args.displayId === undefined ? {} : { displayId: args.displayId }),
      ...(args.reset === true ? { reset: true as const } : {}),
      ...(args.replaceOthers === false ? { replaceOthers: false as const } : {}),
      ...(args.spec.strings && args.locale !== undefined ? { locale: args.locale } : {}),
      ...(args.appearance === undefined ? {} : { appearance: args.appearance }),
    };
  },

  savePrototype(args: {
    requestId: string;
    spec: PrototypeSpec;
    label: string;
    icon?: string;
  }): SavePrototypeMessage {
    return {
      type: "save_prototype",
      requestId: args.requestId,
      spec: args.spec,
      label: args.label,
      ...(args.icon === undefined ? {} : { icon: args.icon }),
    };
  },
  pinSavedPrototype(args: {
    requestId: string;
    id: string;
    icon?: string;
  }): PinSavedPrototypeMessage {
    return {
      type: "pin_saved_prototype",
      requestId: args.requestId,
      id: args.id,
      ...(args.icon === undefined ? {} : { icon: args.icon }),
    };
  },
  listSavedPrototypes(args: { requestId: string }): ListSavedPrototypesMessage {
    return { type: "list_saved_prototypes", requestId: args.requestId };
  },
  deleteSavedPrototype(args: { requestId: string; id: string }): DeleteSavedPrototypeMessage {
    return { type: "delete_saved_prototype", requestId: args.requestId, id: args.id };
  },
  advancePrototypeClock: (args: {
    requestId: string;
    id: string;
    advanceTimeMs: number;
  }): AdvancePrototypeClockMessage => ({ type: "advance_prototype_clock", ...args }),
  clearPrototypeStorage: clearPrototypeStorageMessage,
  patchPrototype(args: { requestId: string } & PrototypePatchRequest): PatchPrototypeMessage {
    return {
      type: "patch_prototype",
      requestId: args.requestId,
      id: args.id,
      ...(args.baseRevision === undefined ? {} : { baseRevision: args.baseRevision }),
      ops: args.ops,
    };
  },

  inspectPrototypes(args: { requestId: string }): InspectPrototypesMessage {
    return { type: "inspect_prototypes", requestId: args.requestId };
  },

  dismissPrototype(args: { requestId: string } & PrototypeDismiss): DismissPrototypeMessage {
    return args.id !== undefined
      ? { type: "dismiss_prototype", requestId: args.requestId, id: args.id }
      : { type: "dismiss_prototype", requestId: args.requestId, all: args.all };
  },

  putPrototypeAsset(args: {
    requestId: string;
    id: string;
    mimeType: string;
    dataBase64: string;
  }): PutPrototypeAssetMessage {
    return {
      type: "put_prototype_asset",
      requestId: args.requestId,
      id: args.id,
      mimeType: args.mimeType,
      dataBase64: args.dataBase64,
    };
  },

  removePrototypeAsset(args: { requestId: string; id: string }): RemovePrototypeAssetMessage {
    return { type: "remove_prototype_asset", requestId: args.requestId, id: args.id };
  },

  addHighlight(args: {
    requestId: string;
    id?: string;
    shape?: HighlightShape;
  }): AddHighlightMessage {
    // Match the pre-migration send site: start with { type, requestId } and only attach id/shape
    // when truthy, so falsy values are omitted from the wire rather than serialized as null.
    const message: AddHighlightMessage = { type: "add_highlight", requestId: args.requestId };
    if (args.id) {
      message.id = args.id;
    }
    if (args.shape) {
      message.shape = args.shape;
    }
    return message;
  },

  listPreferenceFiles(args: {
    requestId: string;
    packageName: string;
  }): ListPreferenceFilesMessage {
    return {
      type: "list_preference_files",
      requestId: args.requestId,
      packageName: args.packageName,
    };
  },

  getPreferences(args: {
    requestId: string;
    packageName: string;
    fileName: string;
  }): GetPreferencesMessage {
    return {
      type: "get_preferences",
      requestId: args.requestId,
      packageName: args.packageName,
      fileName: args.fileName,
    };
  },

  resetKeystore(args: {
    requestId: string;
    packageName: string;
    scope?: string;
    alias?: string;
  }): ResetKeystoreMessage {
    return { type: "reset_keystore", ...args };
  },

  discoverKeystore(args: { requestId: string; packageName: string }): DiscoverKeystoreMessage {
    return { type: "discover_keystore", ...args };
  },

  getSdkCapabilities(args: {
    requestId: string;
    packageName: string;
    userId?: number;
  }): GetSdkCapabilitiesMessage {
    return { type: "get_sdk_capabilities", ...args };
  },

  listDataStores(args: {
    requestId: string;
    packageName: string;
    adapterName: string;
  }): ListDataStoresMessage {
    return {
      type: "list_data_stores",
      requestId: args.requestId,
      packageName: args.packageName,
      adapterName: args.adapterName,
    };
  },

  getDataStore(args: {
    requestId: string;
    packageName: string;
    adapterName: string;
    storeName: string;
  }): GetDataStoreMessage {
    return {
      type: "get_data_store",
      requestId: args.requestId,
      packageName: args.packageName,
      adapterName: args.adapterName,
      storeName: args.storeName,
    };
  },

  subscribeStorage(args: {
    requestId: string;
    packageName: string;
    fileName: string;
  }): SubscribeStorageMessage {
    return {
      type: "subscribe_storage",
      requestId: args.requestId,
      packageName: args.packageName,
      fileName: args.fileName,
    };
  },

  unsubscribeStorage(args: {
    requestId: string;
    subscriptionId: string;
  }): UnsubscribeStorageMessage {
    return {
      type: "unsubscribe_storage",
      requestId: args.requestId,
      subscriptionId: args.subscriptionId,
    };
  },

  getPreference(args: {
    requestId: string;
    packageName: string;
    fileName: string;
    key: string;
  }): GetPreferenceMessage {
    return {
      type: "get_preference",
      requestId: args.requestId,
      packageName: args.packageName,
      fileName: args.fileName,
      key: args.key,
    };
  },

  setPreference(args: {
    requestId: string;
    packageName: string;
    fileName: string;
    key: string;
    value: string | null;
    valueType: KeyValueType;
  }): SetPreferenceMessage {
    return {
      type: "set_preference",
      requestId: args.requestId,
      packageName: args.packageName,
      fileName: args.fileName,
      key: args.key,
      value: args.value,
      valueType: args.valueType,
    };
  },

  removePreference(args: {
    requestId: string;
    packageName: string;
    fileName: string;
    key: string;
  }): RemovePreferenceMessage {
    return {
      type: "remove_preference",
      requestId: args.requestId,
      packageName: args.packageName,
      fileName: args.fileName,
      key: args.key,
    };
  },

  clearPreferences(args: {
    requestId: string;
    packageName: string;
    fileName: string;
  }): ClearPreferencesMessage {
    return {
      type: "clear_preferences",
      requestId: args.requestId,
      packageName: args.packageName,
      fileName: args.fileName,
    };
  },

  requestGlobalAction(args: {
    requestId: string;
    action: string;
    frameContext?: string;
  }): RequestGlobalActionMessage {
    return {
      type: "request_global_action",
      requestId: args.requestId,
      action: args.action,
      frameContext: args.frameContext,
    };
  },

  validateFrameContext(args: {
    requestId: string;
    frameContext: string;
  }): ValidateFrameContextMessage {
    return {
      type: "validate_frame_context",
      requestId: args.requestId,
      frameContext: args.frameContext,
    };
  },

  setRecompositionTracking(args: {
    requestId: string;
    enabled: boolean;
  }): SetRecompositionTrackingMessage {
    return { type: "set_recomposition_tracking", requestId: args.requestId, enabled: args.enabled };
  },

  setAccessibilityFlags(args: {
    includeNotImportantViews: boolean;
    reportViewIds: boolean;
    retrieveInteractiveWindows: boolean;
    occlusionEnabled: boolean;
  }): SetAccessibilityFlagsMessage {
    return {
      type: "set_accessibility_flags",
      includeNotImportantViews: args.includeNotImportantViews,
      reportViewIds: args.reportViewIds,
      retrieveInteractiveWindows: args.retrieveInteractiveWindows,
      occlusionEnabled: args.occlusionEnabled,
    };
  },

  setNetworkMockRules(args: { rules: NetworkMockRuleSync[] }): SetNetworkMockRulesMessage {
    return { type: "set_network_mock_rules", rules: args.rules };
  },

  setNetworkErrorSimulation(args: {
    enabled: boolean;
    errorType?: string | null;
    limit?: number | null;
    expiresAtEpochMs?: number | null;
    remainingMs?: number | null;
  }): SetNetworkErrorSimulationMessage {
    return {
      type: "set_network_error_simulation",
      enabled: args.enabled,
      errorType: args.errorType ?? null,
      limit: args.limit ?? null,
      expiresAtEpochMs: args.expiresAtEpochMs ?? null,
      remainingMs: args.remainingMs ?? null,
    };
  },

  requestInstalledPackages(args: {
    requestId: string;
    includeSystem: boolean;
    userId?: number | null;
  }): RequestInstalledPackagesMessage {
    return {
      type: "request_installed_packages",
      requestId: args.requestId,
      includeSystem: args.includeSystem,
      userId: args.userId ?? null,
    };
  },

  requestPackageInfo(args: {
    requestId: string;
    packageName: string;
    includePermissions: boolean;
  }): RequestPackageInfoMessage {
    return {
      type: "request_package_info",
      requestId: args.requestId,
      packageName: args.packageName,
      includePermissions: args.includePermissions,
    };
  },

  requestLaunchIntent(args: {
    requestId: string;
    packageName: string;
  }): RequestLaunchIntentMessage {
    return {
      type: "request_launch_intent",
      requestId: args.requestId,
      packageName: args.packageName,
    };
  },

  startRecording(): StartRecordingMessage {
    return { type: "start_recording" };
  },

  stopRecording(): StopRecordingMessage {
    return { type: "stop_recording" };
  },
} as const;
