package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.ScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeScrollNode
import dev.jasonpearson.automobile.protocol.PrototypeSetStateAction

/** The latest `scrollTo` per scroll id, from the runtime snapshot (#14232). */
internal val LocalPrototypeScrollRequests =
  staticCompositionLocalOf<Map<String, PrototypeScrollRequest>> { emptyMap() }

/** Where each repeat row of the enclosing scroll is laid out, for `scrollTo {key}`. */
internal val LocalPrototypeScrollAnchors =
  staticCompositionLocalOf<PrototypeScrollAnchors?> { null }

internal class PrototypeScrollAnchors {
  var viewport: LayoutCoordinates? = null
  val rows = mutableMapOf<String, LayoutCoordinates>()

  /** The row's top within the scroll content: its top in the viewport plus the content offset. */
  fun rowTop(key: String, contentOffset: Int): Int? {
    val viewport = viewport?.takeIf { it.isAttached } ?: return null
    val row = rows[key]?.takeIf { it.isAttached } ?: return null
    return viewport.localPositionOf(row, Offset.Zero).y.toInt() + contentOffset
  }
}

/** Records a repeat row's position for the enclosing chat scroll; nothing outside one. */
@Composable
internal fun Modifier.prototypeScrollAnchor(identity: String): Modifier {
  val anchors = LocalPrototypeScrollAnchors.current ?: return this
  val key = PrototypeChatScroll.rowKey(identity) ?: return this
  return onGloballyPositioned { anchors.rows[key] = it }
}

/**
 * The chat-scroll effects of a vertical scroll (#14232): writes `atEndKey` when the end position
 * changes, follows appended rows with `stickToEnd`, runs `onStartReached` each time the start is
 * reached and performs `scrollTo` requests for the scroll's id.
 */
@Composable
internal fun PrototypeChatScrollEffects(
  source: PrototypeScrollNode,
  scroll: ScrollState,
  anchors: PrototypeScrollAnchors,
  interact: (PrototypeInteraction) -> Unit,
) {
  val reverse = source.reverse == true
  val currentInteract by rememberUpdatedState(interact)
  val currentSource by rememberUpdatedState(source)
  LaunchedEffect(scroll, reverse) {
    var wasAtEnd: Boolean? = null
    var wasAtStart = false
    var lastMax = scroll.maxValue
    snapshotFlow { scroll.value to scroll.maxValue }
      .collect { (value, max) ->
        val node = currentSource
        if (
          PrototypeChatScroll.follows(
            node.stickToEnd == true,
            reverse,
            wasAtEnd == true,
            max > lastMax,
          )
        ) {
          lastMax = max
          scroll.scrollTo(max)
          return@collect
        }
        lastMax = max
        val atEnd = PrototypeChatScroll.atEnd(value, max, reverse)
        if (atEnd != wasAtEnd) {
          wasAtEnd = atEnd
          node.atEndKey?.let { key ->
            currentInteract(
              PrototypeInteraction.Tap(
                listOf(PrototypeSetStateAction(key, PrototypeScalar.BooleanValue(atEnd))),
              ),
            )
          }
        }
        val atStart = PrototypeChatScroll.atStart(value, max, reverse)
        if (atStart && !wasAtStart)
          node.onStartReached?.let { currentInteract(PrototypeInteraction.Tap(it)) }
        wasAtStart = atStart
      }
  }
  val request = source.id?.let { LocalPrototypeScrollRequests.current[it] }
  val handled = remember { HandledScrollRequest() }
  LaunchedEffect(request?.sequence) {
    val pending = request?.takeIf { it.sequence != handled.sequence } ?: return@LaunchedEffect
    handled.sequence = pending.sequence
    val max = scroll.maxValue
    val contentOffset = if (reverse) max - scroll.value else scroll.value
    val rowTop =
      (pending.target as? PrototypeScrollTarget.Key)?.let { anchors.rowTop(it.key, contentOffset) }
    val offset =
      PrototypeChatScroll.offset(pending.target, max, reverse, rowTop) ?: return@LaunchedEffect
    if (pending.animated) scroll.animateScrollTo(offset) else scroll.scrollTo(offset)
  }
}

/** The request a scroll last performed, so recomposition does not repeat it. */
private class HandledScrollRequest {
  var sequence: Long = 0L
}
