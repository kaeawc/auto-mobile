import { parsePrototypeStacks } from "./CtrlProxyPrototypes";
import { prototypePatchReplyFields } from "../../prototype/prototypePatchWire";
import { logger } from "../../../utils/logger";
import {
  CurrentFocusResult,
  TraversalOrderResult,
  HighlightOperationResult,
} from "../../../models";

import { imeCommitUnitFields, type ImeCommitActionResult } from "./CtrlProxyText";
import { KeyboardProfileCatalog } from "../../action/keyboardProfiles";
import { prototypeSavedReplyFields } from "./CtrlProxyPrototypes";
import { PrototypeResult } from "./ctrlProxyProtocol";
import {
  AccessibilityNode,
  A11ySwipeResult,
  A11yTapCoordinatesResult,
  A11yDragResult,
  A11yPinchResult,
  A11ySetTextResult,
  A11yImeActionResult,
  A11ySelectAllResult,
  A11yActionResult,
  A11yClipboardResult,
  A11yCaCertResult,
  A11yDeviceOwnerStatusResult,
  A11yPermissionResult,
  A11ySettingsGetResult,
  A11ySettingsPutResult,
  A11ySettingsListResult,
  A11yInstalledPackagesResult,
  A11yPackageInfoResult,
  A11yLaunchIntentResult,
} from "./types";
import type { AndroidInboundMessageRouterContext } from "./AndroidInboundMessageRouterContext";
import type { WebSocketMessageHandlers } from "./androidCtrlProxyInboundProtocol";
export class AndroidInboundResponseHandlers {
  constructor(private readonly ctx: AndroidInboundMessageRouterContext) {}
  readonly handlers = {
    swipe_result: (message) => {
      logger.debug(
        `[CTRL_PROXY] Swipe result (requestId: ${message.requestId}, success: ${message.success})`,
      );

      if (message.requestId) {
        this.ctx.requestManager.resolve<A11ySwipeResult>(message.requestId, {
          success: message.success,
          totalTimeMs: message.totalTimeMs,
          gestureTimeMs: message.gestureTimeMs,
          error: message.error,
          perfTiming: message.perfTiming,
        });
      }
    },

    tap_coordinates_result: (message) => {
      logger.info(
        `[CTRL_PROXY] Tap coordinates result (requestId: ${message.requestId}, success: ${message.success})`,
      );

      if (message.requestId) {
        this.ctx.requestManager.resolve<A11yTapCoordinatesResult>(message.requestId, {
          success: message.success,
          totalTimeMs: message.totalTimeMs,
          error: message.error,
          perfTiming: message.perfTiming,
          acknowledged: true,
        });
      }
    },

    drag_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): A11yDragResult => ({
        success: message.success,
        totalTimeMs: message.totalTimeMs,
        gestureTimeMs: message.gestureTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    pinch_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): A11yPinchResult => ({
        success: message.success,
        totalTimeMs: message.totalTimeMs,
        gestureTimeMs: message.gestureTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    set_text_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): A11ySetTextResult => ({
        success: message.success,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    commit_text_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): ImeCommitActionResult => ({
        success: message.success,
        ...(typeof message.insertedText === "string" ? { insertedText: message.insertedText } : {}),
        ...(message.editorConsumed === true ? { editorConsumed: true } : {}),
        ...(Array.isArray(message.trace) &&
        message.trace.every((line): line is string => typeof line === "string")
          ? { trace: message.trace.slice(-256) }
          : {}),
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        partialApplication: message.partialApplication,
        ...imeCommitUnitFields(message),
        perfTiming: message.perfTiming,
      })),

    cancel_ime_commit_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message) => ({
        success: message.success,
        targetRequestId: message.targetRequestId,
        partialApplication: message.partialApplication,
        ...imeCommitUnitFields(message),
        error: message.error,
      })),

    set_keyboard_profile_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message) => ({
        success: message.success,
        activeProfileId: message.activeProfileId,
        previousProfileId: message.previousProfileId,
        error: message.error,
      })),

    set_network_mock_rules_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message) => ({
        success: message.success ?? true,
        totalTimeMs: 0,
        rejectedMockIds: message.rejectedMockIds,
        rejectedReasons: message.rejectedReasons,
        error: message.error,
      })),

    keyboard_profiles_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): KeyboardProfileCatalog => ({
        success: message.success,
        catalogId: message.catalogId,
        catalogVersion: message.catalogVersion,
        supportedCatalogVersions: message.supportedCatalogVersions,
        activeProfileId: message.activeProfileId,
        profiles: message.profiles,
        error: message.error,
      })),

    insert_text_state_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message) => ({
        success: message.success,
        state: message.state,
      })),

    insert_text_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): A11ySetTextResult => ({
        success: message.success,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        partialApplication: message.partialApplication,
        warning: message.warning,
        caretPlaced: message.caretPlaced,
        resultingTextLength: message.resultingTextLength,
        perfTiming: message.perfTiming,
      })),

    ime_action_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): A11yImeActionResult => ({
        success: message.success,
        action: message.action,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        ...(message.approximated === undefined ? {} : { approximated: message.approximated }),
        perfTiming: message.perfTiming,
      })),

    select_all_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): A11ySelectAllResult => ({
        success: message.success,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    action_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): A11yActionResult => ({
        success: message.success,
        action: message.action,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
        ...(message.alreadySatisfied ? { alreadySatisfied: true } : {}),
      })),

    clipboard_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): A11yClipboardResult => ({
        success: message.success,
        action: message.action,
        text: message.text,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    settings_get_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): A11ySettingsGetResult => ({
        success: message.success,
        value: message.value,
        found: message.found ?? false,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    settings_put_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): A11ySettingsPutResult => ({
        success: message.success,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    settings_list_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): A11ySettingsListResult => ({
        success: message.success,
        entries: message.entries,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    installed_packages_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): A11yInstalledPackagesResult => ({
        success: message.success ?? false,
        userId: message.userId ?? -1,
        packages: message.packages ?? [],
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    package_info_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): A11yPackageInfoResult => ({
        success: message.success ?? false,
        packageName: message.packageName ?? "",
        isSystem: message.isSystem ?? false,
        applicationLabel: message.applicationLabel,
        versionName: message.versionName,
        versionCode: message.versionCode,
        installerPackage: message.installerPackage,
        firstInstallTime: message.firstInstallTime,
        lastUpdateTime: message.lastUpdateTime,
        allowBackup: message.allowBackup,
        requestedPermissions: message.requestedPermissions ?? [],
        grantedPermissions: message.grantedPermissions ?? {},
        mainActivity: message.mainActivity,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    launch_intent_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): A11yLaunchIntentResult => ({
        success: message.success ?? false,
        packageName: message.packageName ?? "",
        componentName: message.componentName,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    ca_cert_result: (message) => {
      if (message.requestId) {
        // Try delegate handler first (for remove)
        if (
          !this.ctx.certificates.handleCaCertRemovalResult(message.requestId, {
            success: message.success,
            action: message.action,
            alias: message.alias,
            totalTimeMs: message.totalTimeMs,
            error: message.error,
            perfTiming: message.perfTiming,
          })
        ) {
          // Fall back to RequestManager (for install)
          this.ctx.requestManager.resolve<A11yCaCertResult>(message.requestId, {
            success: message.success,
            action: message.action,
            alias: message.alias,
            totalTimeMs: message.totalTimeMs,
            error: message.error,
            perfTiming: message.perfTiming,
          });
        }
      }
    },

    device_owner_status_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): A11yDeviceOwnerStatusResult => ({
        success: message.success,
        isDeviceOwner: message.isDeviceOwner ?? false,
        isAdminActive: message.isAdminActive ?? false,
        packageName: message.packageName,
        totalTimeMs: message.totalTimeMs,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    permission_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): A11yPermissionResult => ({
        success: message.success ?? false,
        permission: message.permission ?? "unknown",
        granted: message.granted ?? false,
        totalTimeMs: message.totalTimeMs ?? 0,
        requestLaunched: message.requestLaunched ?? false,
        canRequest: message.canRequest ?? false,
        requiresSettings: message.requiresSettings ?? false,
        instructions: message.instructions,
        adbCommand: message.adbCommand,
        error: message.error,
        perfTiming: message.perfTiming,
      })),

    current_focus_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): CurrentFocusResult => {
        const focusedElement = message.focusedElement
          ? this.ctx.focus.convertAccessibilityNodeToElement(message.focusedElement)
          : null;
        return {
          focusedElement,
          totalTimeMs: message.totalTimeMs,
          requestId: message.requestId,
          error: message.error,
        };
      }),

    traversal_order_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): TraversalOrderResult => {
        const result = message.result;
        if (result && result.elements) {
          const converted = result.elements.map((node: AccessibilityNode) =>
            this.ctx.focus.convertAccessibilityNodeToElement(node),
          );
          const elements = converted.filter((element) => element !== null);
          const dropped = converted.length - elements.length;
          if (dropped > 0) {
            logger.debug(`[CTRL_PROXY] Dropped ${dropped} traversal nodes that failed conversion`);
          }
          const focusedElement =
            result.focusedIndex === null ? null : converted[result.focusedIndex];
          return {
            elements,
            focusedIndex: focusedElement ? elements.indexOf(focusedElement) : null,
            totalCount: dropped > 0 ? elements.length : result.totalCount,
            truncationReasons: result.truncationReasons,
            totalTimeMs: message.totalTimeMs,
            requestId: message.requestId,
            error: message.error,
          };
        }
        return {
          elements: [],
          focusedIndex: null,
          totalCount: 0,
          totalTimeMs: message.totalTimeMs,
          requestId: message.requestId,
          error: message.error || "No result data",
        };
      }),

    prototype_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message): PrototypeResult => ({
        success: message.success,
        error: message.error,
        requestId: message.requestId,
        timestamp: message.timestamp,
        ...(Array.isArray(message.missingAssets) && message.missingAssets.length > 0
          ? { missingAssets: message.missingAssets.filter((id) => typeof id === "string") }
          : {}),
        ...prototypePatchReplyFields(message),
        ...prototypeSavedReplyFields(message),
        ...(Array.isArray(message.prototypes) ? { prototypes: message.prototypes } : {}),
        ...(parsePrototypeStacks(message.stacks)
          ? { stacks: parsePrototypeStacks(message.stacks) }
          : {}),
        ...(typeof message.droppedEvents === "number"
          ? { droppedEvents: message.droppedEvents }
          : {}),
        ...(Number.isSafeInteger(message.cleared) && message.cleared! >= 0
          ? { cleared: message.cleared }
          : {}),
      })),

    highlight_response: (message) =>
      this.ctx.resolvePendingResponse(message, (message): HighlightOperationResult => ({
        success: message.success ?? false,
        error: message.error,
        requestId: message.requestId,
        timestamp: message.timestamp,
      })),

    global_action_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message) => ({
        success: message.success ?? false,
        action: message.action,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    frame_context_validation_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message) => ({
        success: message.success ?? false,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    device_info_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message) => ({
        success: message.success ?? false,
        screenWidth: message.screenWidth,
        screenHeight: message.screenHeight,
        density: message.density,
        rotation: message.rotation,
        sdkInt: message.sdkInt,
        deviceModel: message.deviceModel,
        isEmulator: message.isEmulator,
        wakefulness: message.wakefulness,
        foregroundActivity: message.foregroundActivity,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    keystore_discovery: (message) =>
      this.ctx.resolvePendingResponse(message, (message) => ({ state: message.state })),

    sdk_capabilities: (message) =>
      this.ctx.resolvePendingResponse(message, (message) => ({ state: message.state })),

    preference_files: (message) =>
      this.ctx.resolvePendingResponse(message, (message) => ({
        success: message.success ?? false,
        files: message.files || [],
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    preferences: (message) =>
      this.ctx.resolvePendingResponse(message, (message) => ({
        success: message.success ?? false,
        entries: message.entries || [],
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    subscribe_storage_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message) => {
        // Android sends flat packageName/fileName/subscriptionId fields, not a nested `subscription`
        // object (like preference_files/preferences above). Rebuild the subscription from them so
        // the awaiting subscribeStorage() promise gets a usable StorageSubscription.
        const subscription =
          message.success && message.subscriptionId
            ? {
                packageName: message.packageName ?? "",
                fileName: message.fileName ?? "",
                subscriptionId: message.subscriptionId,
              }
            : undefined;
        return {
          success: message.success ?? false,
          subscription,
          totalTimeMs: message.totalTimeMs ?? 0,
          error: message.error,
        };
      }),

    unsubscribe_storage_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message) => ({
        success: message.success ?? false,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    get_preference_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message) => {
        // Build entry from key/value/type fields (Android sends flat structure, not nested entry)
        const entry =
          message.found && message.key
            ? {
                key: message.key,
                value: message.value,
                type: message.valueType ?? "UNKNOWN",
              }
            : undefined;
        return {
          success: message.success ?? false,
          found: message.found ?? false,
          entry,
          totalTimeMs: message.totalTimeMs ?? 0,
          error: message.error,
        };
      }),

    set_preference_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message) => ({
        success: message.success ?? false,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    remove_preference_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message) => ({
        success: message.success ?? false,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),

    clear_preferences_result: (message) =>
      this.ctx.resolvePendingResponse(message, (message) => ({
        success: message.success ?? false,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      })),
  } satisfies Pick<
    WebSocketMessageHandlers,
    | "swipe_result"
    | "tap_coordinates_result"
    | "drag_result"
    | "pinch_result"
    | "set_text_result"
    | "commit_text_result"
    | "cancel_ime_commit_result"
    | "set_keyboard_profile_result"
    | "set_network_mock_rules_result"
    | "keyboard_profiles_result"
    | "insert_text_state_result"
    | "insert_text_result"
    | "ime_action_result"
    | "select_all_result"
    | "action_result"
    | "clipboard_result"
    | "settings_get_result"
    | "settings_put_result"
    | "settings_list_result"
    | "installed_packages_result"
    | "package_info_result"
    | "launch_intent_result"
    | "ca_cert_result"
    | "device_owner_status_result"
    | "permission_result"
    | "current_focus_result"
    | "traversal_order_result"
    | "prototype_result"
    | "highlight_response"
    | "global_action_result"
    | "frame_context_validation_result"
    | "device_info_result"
    | "keystore_discovery"
    | "sdk_capabilities"
    | "preference_files"
    | "preferences"
    | "subscribe_storage_result"
    | "unsubscribe_storage_result"
    | "get_preference_result"
    | "set_preference_result"
    | "remove_preference_result"
    | "clear_preferences_result"
  >;
}
