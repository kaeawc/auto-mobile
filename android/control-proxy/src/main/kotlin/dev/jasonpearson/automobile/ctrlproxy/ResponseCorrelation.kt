package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.*

/** Typed response-ID accessors used by the exhaustive server dispatcher. */
internal object ResponseCorrelation {
  fun interactionRequestId(response: WebSocketResponse): String? =
    when (response) {
      is ErrorResponse -> response.requestId
      is ScreenshotResult -> response.requestId
      is ScreenshotErrorResult -> response.requestId
      is SwipeResult -> response.requestId
      is TapCoordinatesResult -> response.requestId
      is DragResult -> response.requestId
      is PinchResult -> response.requestId
      is SetTextResult -> response.requestId
      is CommitTextResult -> response.requestId
      is InsertTextResult -> response.requestId
      is InsertTextStateResult -> response.requestId
      is CancelImeCommitResult -> response.requestId
      else -> null // Only the types listed in the exhaustive dispatcher reach this group.
    }

  fun deviceControlRequestId(response: WebSocketResponse): String? =
    when (response) {
      is SetKeyboardProfileResult -> response.requestId
      is SetNetworkMockRulesResult -> response.requestId
      is KeyboardProfileCatalogResult -> response.requestId
      is ImeActionResult -> response.requestId
      is SelectAllResult -> response.requestId
      is ActionResult -> response.requestId
      is ClipboardResult -> response.requestId
      is SettingsGetResult -> response.requestId
      is SettingsPutResult -> response.requestId
      is SettingsListResult -> response.requestId
      is CaCertResult -> response.requestId
      is DeviceOwnerStatusResult -> response.requestId
      else -> null // Only the types listed in the exhaustive dispatcher reach this group.
    }

  fun inspectionRequestId(response: WebSocketResponse): String? =
    when (response) {
      is PermissionResult -> response.requestId
      is GlobalActionResult -> response.requestId
      is FrameContextValidationResult -> response.requestId
      is DeviceInfoResult -> response.requestId
      is CurrentFocusResult -> response.requestId
      is TraversalOrderResult -> response.requestId
      is HighlightResponse -> response.requestId
      is PrototypeResult -> response.requestId
      is dev.jasonpearson.automobile.protocol.KeystoreDiscoveryResult -> response.requestId
      is dev.jasonpearson.automobile.protocol.SdkCapabilitiesResult -> response.requestId
      is PreferenceFilesResult -> response.requestId
      is PreferencesResult -> response.requestId
      else -> null // Only the types listed in the exhaustive dispatcher reach this group.
    }

  fun storageAndPackageRequestId(response: WebSocketResponse): String? =
    when (response) {
      is SubscribeStorageResult -> response.requestId
      is UnsubscribeStorageResult -> response.requestId
      is GetPreferenceResult -> response.requestId
      is SetPreferenceResult -> response.requestId
      is RemovePreferenceResult -> response.requestId
      is ClearPreferencesResult -> response.requestId
      is InstalledPackagesResult -> response.requestId
      is PackageInfoResult -> response.requestId
      is LaunchIntentResult -> response.requestId
      is HierarchyUpdateEvent -> response.requestId
      else -> null // Only the types listed in the exhaustive dispatcher reach this group.
    }
}
