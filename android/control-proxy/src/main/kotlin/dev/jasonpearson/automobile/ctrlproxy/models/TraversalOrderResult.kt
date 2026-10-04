package dev.jasonpearson.automobile.ctrlproxy.models

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable

/**
 * Result containing ordered accessibility-focusable elements in TalkBack traversal order.
 *
 * @property elements List of elements in traversal order (depth-first, left-to-right)
 * @property focusedIndex Index of currently focused element in the list, or null if no element has
 *   focus
 * @property totalCount Total number of focusable elements found
 * @property truncationReasons Reasons the traversal is incomplete, omitted for a complete traversal
 */
@Serializable
@OptIn(ExperimentalSerializationApi::class)
data class TraversalOrderResult(
  val elements: List<UIElementInfo>,
  val focusedIndex: Int? = null,
  val totalCount: Int = elements.size,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val truncationReasons: List<String>? = null,
)
