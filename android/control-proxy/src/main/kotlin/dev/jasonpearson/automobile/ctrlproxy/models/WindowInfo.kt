package dev.jasonpearson.automobile.ctrlproxy.models

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable

/** Window information */
@Serializable
@OptIn(ExperimentalSerializationApi::class)
data class WindowInfo(
  val id: Int? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val displayId: Int? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val panelUniqueId: String? = null,
  val type: Int? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val windowLayer: Int? = null,
  val isActive: Boolean = false,
  val isFocused: Boolean = false,
  val bounds: ElementBounds? = null,
  /**
   * Package of the window's root node. Lets the host tell which app owns a window (e.g. that a
   * focused accessibility-overlay window is CtrlProxy's own). Omitted when the root reports none;
   * older APKs never send it.
   */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val packageName: String? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val truncationReasons: List<String>? = null,
)
