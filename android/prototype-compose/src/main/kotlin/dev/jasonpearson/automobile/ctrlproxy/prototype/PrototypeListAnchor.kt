package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.lazy.LazyListState

internal data class PrototypeListAnchorTarget(val index: Int, val offset: Int)

/** Row coordinates exclude headers and footers; offsets use LazyListState scroll pixels. */
internal data class PrototypeListAnchor(
  val key: String?,
  val index: Int,
  val offset: Int,
  val headerVisible: Boolean = false,
) {
  fun restore(newKeys: List<String>, hasHeader: Boolean): PrototypeListAnchorTarget {
    if (headerVisible && hasHeader && key != null && newKeys.firstOrNull() == key) {
      return PrototypeListAnchorTarget(0, offset)
    }
    resolve(key, offset, newKeys, hasHeader)?.let {
      return it
    }
    if (newKeys.isEmpty()) return PrototypeListAnchorTarget(0, 0)
    return PrototypeListAnchorTarget(
      index.coerceIn(newKeys.indices) + if (hasHeader) 1 else 0,
      offset,
    )
  }

  companion object {
    fun resolve(
      anchorKey: String?,
      offset: Int,
      newKeys: List<String>,
      hasHeader: Boolean,
    ): PrototypeListAnchorTarget? {
      val index = anchorKey?.let(newKeys::indexOf) ?: -1
      if (index < 0) return null
      return PrototypeListAnchorTarget(index + if (hasHeader) 1 else 0, offset)
    }

    fun capture(state: LazyListState, keys: List<String>, hasHeader: Boolean): PrototypeListAnchor {
      val row = state.layoutInfo.visibleItemsInfo.firstOrNull { it.contentType == "row" }
      val index =
        ((row?.index ?: state.firstVisibleItemIndex) - if (hasHeader) 1 else 0).coerceAtLeast(0)
      return PrototypeListAnchor(
        (row?.key as? String)?.removePrefix("row:") ?: keys.getOrNull(index),
        index,
        state.firstVisibleItemScrollOffset,
        hasHeader && state.firstVisibleItemIndex == 0,
      )
    }
  }
}
