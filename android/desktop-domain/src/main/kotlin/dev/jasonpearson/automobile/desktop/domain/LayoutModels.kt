package dev.jasonpearson.automobile.desktop.domain

/**
 * How a hierarchy node changed since the previous observation-stream frame, as annotated by the
 * daemon's per-frame diff. [Added] nodes are new this frame; [Changed] nodes exist at the same tree
 * position with a changed attribute. Unchanged nodes carry no state (null), so hierarchies without
 * diff metadata render exactly as before.
 */
public enum class NodeDiffState {
  Added,
  Changed,
}

public data class UIElementInfo(
  val id: String,
  val className: String,
  val resourceId: String?,
  val text: String?,
  val contentDescription: String?,
  val bounds: ElementBounds,
  val isClickable: Boolean,
  val isEnabled: Boolean,
  val isFocused: Boolean,
  val isSelected: Boolean,
  val isScrollable: Boolean,
  val isCheckable: Boolean,
  val isChecked: Boolean,
  val children: List<UIElementInfo>,
  val depth: Int,
  val extras: Map<String, String> = emptyMap(),
  val diffState: NodeDiffState? = null,
)

public data class ElementBounds(
  val left: Int,
  val top: Int,
  val right: Int,
  val bottom: Int,
) {
  public val width: Int
    get() = right - left

  public val height: Int
    get() = bottom - top

  public val centerX: Int
    get() = left + width / 2

  public val centerY: Int
    get() = top + height / 2

  public val area: Long
    get() = width.toLong() * height.toLong()

  public fun contains(x: Int, y: Int): Boolean = x >= left && x < right && y >= top && y < bottom
}

public data class ScreenshotFrame(
  val data: ByteArray,
  val width: Int,
  val height: Int,
  val timestamp: Long,
) {
  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is ScreenshotFrame) return false
    return timestamp == other.timestamp && width == other.width && height == other.height
  }

  override fun hashCode(): Int {
    var result = timestamp.hashCode()
    result = 31 * result + width
    result = 31 * result + height
    return result
  }
}

public enum class ConnectionStatus {
  Disconnected,
  Connecting,
  Connected,
  Error,
}

public enum class StreamingMode {
  Paused,
  Live,
}

public data class ParsedHierarchy(
  val root: UIElementInfo,
  val elementMap: Map<String, UIElementInfo>,
  val parentMap: Map<String, String>,
  val rotation: Int = 0,
)

public data class ObservationData(
  val hierarchy: UIElementInfo,
  val screenshotData: ByteArray? = null,
  val screenWidth: Int = 1080,
  val screenHeight: Int = 2340,
  val timestamp: Long = System.currentTimeMillis(),
  val rotation: Int = 0,
) {
  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is ObservationData) return false
    return hierarchy == other.hierarchy &&
      screenshotData.contentEquals(other.screenshotData) &&
      screenWidth == other.screenWidth &&
      screenHeight == other.screenHeight &&
      timestamp == other.timestamp &&
      rotation == other.rotation
  }

  override fun hashCode(): Int {
    var result = hierarchy.hashCode()
    result = 31 * result + (screenshotData?.contentHashCode() ?: 0)
    result = 31 * result + screenWidth
    result = 31 * result + screenHeight
    result = 31 * result + timestamp.hashCode()
    result = 31 * result + rotation
    return result
  }
}

public data class InstalledApp(
  val packageName: String,
  val displayName: String?,
  val isForeground: Boolean,
)
