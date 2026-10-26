package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeListNode
import dev.jasonpearson.automobile.protocol.PrototypeListRows
import kotlinx.serialization.json.JsonObject

/** One signature per page/window, retained until a new show recreates the holder. */
internal class PrototypeListEndTrigger(private val endThreshold: Int) {
  private var fired: Pair<Int, String?>? = null

  fun onVisibleRange(lastVisibleIndex: Int, rowCount: Int, lastRowKey: String?): Boolean {
    val signature = rowCount to lastRowKey
    if (rowCount <= 0 || lastVisibleIndex < rowCount - endThreshold || fired == signature)
      return false
    fired = signature
    return true
  }
}

/** Row data and an on-demand mapper; no expanded row tree is retained here. */
@InternalAutoMobilePrototypeApi
class PrototypeLazyListModel
internal constructor(
  val source: PrototypeListNode,
  val rows: List<JsonObject>,
  /** Every mapping input a row binds against, so equal snapshots map equal rows. */
  internal val snapshot: Any,
  internal val render: (JsonObject, Int) -> PrototypeRenderNode,
) {
  fun key(index: Int): String = PrototypeListRows.key(source, rows[index])

  override fun equals(other: Any?): Boolean =
    other is PrototypeLazyListModel &&
      source == other.source &&
      rows == other.rows &&
      snapshot == other.snapshot

  override fun hashCode(): Int = 31 * (31 * source.hashCode() + rows.hashCode()) + snapshot.hashCode()
}

@Composable
internal fun RenderPrototypeLazyList(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
  render: @Composable (PrototypeRenderNode) -> Unit,
) {
  val model = checkNotNull(node.list)
  val source = model.source
  val epoch = LocalPrototypeShowEpoch.current
  val state = key(epoch, node.identity) { rememberLazyListState() }
  val trigger =
    remember(epoch, node.identity, source.endThreshold) {
      PrototypeListEndTrigger(source.endThreshold)
    }
  val header = node.children.firstOrNull { it.identity == "${node.identity}.header" }
  val footer = node.children.firstOrNull { it.identity == "${node.identity}.footer" }
  PrototypeListEndEffect(model, state, trigger, header != null, interact)
  val content: @Composable (Modifier) -> Unit = { listModifier ->
    val items: androidx.compose.foundation.lazy.LazyListScope.() -> Unit = {
      if (header != null) item(key = "header", contentType = "header") { render(header) }
      itemsIndexed(
        model.rows,
        key = { _, item -> "row:${PrototypeListRows.key(source, item)}" },
        contentType = { _, _ -> "row" },
      ) { index, item ->
        render(model.render(item, index))
      }
      if (footer != null) item(key = "footer", contentType = "footer") { render(footer) }
    }
    val spacing = Arrangement.spacedBy((source.spacing ?: 0.0).toFloat().dp)
    val padding = PaddingValues((source.contentPadding ?: 0.0).toFloat().dp)
    if (source.axis == "horizontal") {
      LazyRow(
        modifier = listModifier,
        state = state,
        horizontalArrangement = spacing,
        verticalAlignment = node.style.verticalAlignment,
        contentPadding = padding,
        content = items,
      )
    } else {
      LazyColumn(
        modifier = listModifier,
        state = state,
        verticalArrangement = spacing,
        horizontalAlignment = node.style.horizontalAlignment,
        contentPadding = padding,
        content = items,
      )
    }
  }
  val refresh = source.refresh?.takeIf { source.axis != "horizontal" }
  if (refresh != null) {
    PrototypeRefreshBox(refresh, node.checked, Modifier, interact) { content(modifier) }
  } else content(modifier)
}

@Composable
private fun PrototypeListEndEffect(
  model: PrototypeLazyListModel,
  state: androidx.compose.foundation.lazy.LazyListState,
  trigger: PrototypeListEndTrigger,
  hasHeader: Boolean,
  interact: (PrototypeInteraction) -> Unit,
) {
  val currentInteract = rememberUpdatedState(interact)
  LaunchedEffect(state, model, trigger) {
    snapshotFlow {
      state.layoutInfo.visibleItemsInfo
        .filter { it.contentType == "row" }
        .maxOfOrNull { it.index - if (hasHeader) 1 else 0 } ?: -1
    }
      .collect { last ->
        if (
          last >= 0 &&
            trigger.onVisibleRange(
              last,
              model.rows.size,
              model.rows.indices.lastOrNull()?.let(model::key),
            )
        ) {
          model.source.onEndReached?.let { currentInteract.value(PrototypeInteraction.Tap(it)) }
        }
      }
  }
}
