package dev.jasonpearson.automobile.ctrlproxy.models

import dev.jasonpearson.automobile.protocol.PrototypeAppearance
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
  /**
   * Only on CtrlProxy's own prototype window while one is showing: `fullscreen`, `sheet` or
   * `floating`. Advertised by `prototype_window_metadata_v1`; omitted otherwise and by older APKs.
   */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val prototypePlacement: String? = null,
  /**
   * Only alongside [prototypePlacement]: true when the prototype's rendered surface is fully opaque
   * (window opacity 100 and an opaque root or scrim).
   */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val prototypeOpaque: Boolean? = null,
  /**
   * Only alongside [prototypePlacement]: the light or dark mode the prototype is drawn in, as
   * `{mode, source, deviceDark}`. Sent by a CtrlProxy advertising `prototype_appearance_v1`;
   * omitted by older APKs.
   */
  @EncodeDefault(EncodeDefault.Mode.NEVER) val prototypeAppearance: PrototypeAppearance? = null,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val truncationReasons: List<String>? = null,
)
