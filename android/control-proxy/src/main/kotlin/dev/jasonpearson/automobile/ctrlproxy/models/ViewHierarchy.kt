package dev.jasonpearson.automobile.ctrlproxy.models

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Complete view hierarchy representation matching the structure expected by AutoMobile test
 * framework
 */
@Serializable
@OptIn(ExperimentalSerializationApi::class)
data class ViewHierarchy
@JvmOverloads
constructor(
  val updatedAt: Long = System.currentTimeMillis(),
  val packageName: String? = null,
  /** Android user that owns the accessibility service that captured this hierarchy. */
  val userId: Int? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val displayId: Int? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val panelUniqueId: String? = null,
  val hierarchy: UIElementInfo? = null,
  val windowInfo: WindowInfo? = null,
  val windows: List<WindowInfo>? = null,
  val contentHiddenRegions: List<ContentHiddenRegion>? = null,
  val intentChooserDetected: Boolean? = null,
  val notificationPermissionDetected: Boolean? = null,
  @SerialName("accessibility-focused-element")
  val accessibilityFocusedElement: UIElementInfo? = null, // Element with TalkBack cursor
  val ctrlProxyIncomplete: Boolean? = null,
  /** Cause of an incomplete capture; omitted for complete captures and older services. */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val ctrlProxyIncompleteReason: String? = null,
  val error: String? = null, // For error cases like locked screen
  val screenWidth: Int? = null,
  val screenHeight: Int? = null,
  val rotation: Int? = null, // 0=portrait, 1=landscape90, 2=reverse, 3=landscape270
  val systemInsets: SystemInsetsInfo? = null,
  val insets: ObservationInsetsInfo? = null,
  val wakefulness: String? = null, // "Awake", "Asleep", or "Dozing"
  val foregroundActivity: String? = null, // e.g. "com.example.app/.MainActivity"
  val density: Int? = null, // Display density in DPI
  val sdkInt: Int? = null, // Android API level (e.g. 34)
  val deviceModel: String? = null, // e.g. "Pixel 8"
  val isEmulator: Boolean? = null, // Whether running on an emulator
  // Runtime AccessibilityServiceInfo.isAccessibilityTool of the bound CtrlProxy service (#6233).
  // Null when unknown (API < 31 has no such flag, or serviceInfo was unavailable).
  val accessibilityTool: Boolean? = null,
  // Additive scale metadata (#4548): the ratio between the bounds units reported in this
  // hierarchy and physical screenshot pixels. Android accessibility bounds and screenshots
  // are BOTH physical pixels, so the truthful value is exactly 1 — reported explicitly so
  // both platforms carry the same metadata shape (iOS reports UIScreen.nativeScale).
  val nativeScale: Float? = null,
  val pixelWidth: Int? = null, // Physical screenshot pixel width (== screenWidth on Android)
  val pixelHeight: Int? = null, // Physical screenshot pixel height (== screenHeight on Android)
  /** Structured reasons why this snapshot is partial or unavailable. */
  val truncationReasons: List<String>? = null,
  /**
   * True only while an AutoMobile prototype exists but is hidden because its app is not in front,
   * so a `layer: "prototype"` call can say so instead of "no prototype is showing". Omitted
   * otherwise.
   */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val prototypeSuspended: Boolean? = null,
)

@Serializable
data class ContentHiddenRegion(
  val bounds: ElementBounds,
  val reason: String,
  val areaPercent: Int,
)
