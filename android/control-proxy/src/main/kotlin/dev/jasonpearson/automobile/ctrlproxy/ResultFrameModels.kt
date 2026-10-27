package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceEntry
import dev.jasonpearson.automobile.protocol.InstalledPackageRecord
import dev.jasonpearson.automobile.protocol.KeyboardProfileInfo

/** Result payloads shared by controllers and frame builders; timing is supplied at broadcast. */
internal data class GestureFrameResult(
  val requestId: String?,
  val success: Boolean,
  val error: String?,
  val totalTimeMs: Long,
  val gestureTimeMs: Long?,
)

internal data class ClipboardFrameResult(
  val requestId: String?,
  val action: String,
  val success: Boolean,
  val text: String?,
  val error: String?,
  val totalTimeMs: Long,
)

internal data class CaCertificateResult(
  val requestId: String?,
  val action: String,
  val success: Boolean,
  val alias: String?,
  val error: String?,
  val totalTimeMs: Long,
)

internal data class DeviceOwnerResult(
  val requestId: String?,
  val packageName: String,
  val isDeviceOwner: Boolean,
  val isAdminActive: Boolean,
  val error: String?,
  val totalTimeMs: Long,
)

internal data class ImeActionFrameResult(
  val requestId: String?,
  val action: String,
  val success: Boolean,
  val error: String?,
  val totalTimeMs: Long,
  val approximated: Boolean? = null,
)

internal data class InsertTextFrameResult(
  val requestId: String?,
  val success: Boolean,
  val error: String?,
  val totalTimeMs: Long,
  val warning: String? = null,
  val caretPlaced: Boolean? = null,
  val resultingTextLength: Int? = null,
  val partialApplication: Boolean = false,
)

internal data class CommitTextFrameResult(
  val requestId: String?,
  val success: Boolean,
  val error: String?,
  val totalTimeMs: Long,
  val partialApplication: Boolean,
  val committedUnits: Int = 0,
  val insertedText: String? = null,
  val trace: List<String>? = null,
  val editorConsumed: Boolean = false,
)

internal data class KeyboardProfilesResult(
  val requestId: String?,
  val success: Boolean,
  val catalogVersion: Int? = null,
  val supportedCatalogVersions: List<Int>,
  val activeProfileId: String? = null,
  val profiles: List<KeyboardProfileInfo> = emptyList(),
  val error: String? = null,
)

internal data class PackageEventResult(
  val timestamp: Long,
  val action: String,
  val packageName: String,
  val userId: Int,
  val uid: Int?,
  val isSystem: Boolean?,
  val removedForAllUsers: Boolean,
)

internal data class InstalledPackagesOutcome(
  val requestId: String?,
  val success: Boolean,
  val userId: Int,
  val packages: List<InstalledPackageRecord>,
  val error: String?,
  val totalTimeMs: Long,
)

internal data class PackageInfoOutcome(
  val requestId: String?,
  val success: Boolean,
  val packageName: String,
  val isSystem: Boolean,
  val applicationLabel: String?,
  val versionName: String?,
  val versionCode: Long?,
  val installerPackage: String?,
  val firstInstallTime: Long?,
  val lastUpdateTime: Long?,
  val allowBackup: Boolean?,
  val requestedPermissions: List<String>,
  val grantedPermissions: Map<String, Boolean>,
  val mainActivity: String?,
  val error: String?,
  val totalTimeMs: Long,
)

internal data class LaunchIntentOutcome(
  val requestId: String?,
  val success: Boolean,
  val packageName: String,
  val componentName: String?,
  val error: String?,
  val totalTimeMs: Long,
)

internal data class SettingsGetOutcome(
  val requestId: String?,
  val namespace: String,
  val key: String,
  val success: Boolean,
  val value: String?,
  val found: Boolean,
  val error: String?,
  val totalTimeMs: Long,
)

internal data class SettingsPutOutcome(
  val requestId: String?,
  val namespace: String,
  val key: String,
  val success: Boolean,
  val error: String?,
  val totalTimeMs: Long,
)

internal data class SettingsListOutcome(
  val requestId: String?,
  val namespace: String,
  val success: Boolean,
  val entries: Map<String, String>?,
  val error: String?,
  val totalTimeMs: Long,
)

internal data class GetPreferenceOutcome(
  val requestId: String?,
  val packageName: String,
  val fileName: String,
  val key: String,
  val entry: PreferenceEntry?,
  val error: String?,
)

internal data class NodeActionResult(
  val requestId: String?,
  val action: String,
  val success: Boolean,
  val error: String?,
  val totalTimeMs: Long,
  val alreadySatisfied: Boolean = false,
)
