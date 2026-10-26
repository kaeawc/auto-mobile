package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import dev.jasonpearson.automobile.protocol.PrototypeStackNode

private const val STACK_DURATION_MS = 300
private const val STACK_FADE_THROUGH_MS = STACK_DURATION_MS / 2

internal class PrototypeBackSeek {
  var preview by mutableStateOf<PrototypeRuntimeSnapshot?>(null)
  var progress by mutableFloatStateOf(0f)
  var result by mutableStateOf<Boolean?>(null)

  fun start(snapshot: PrototypeRuntimeSnapshot) {
    progress = 0f
    result = null
    preview = snapshot
  }

  fun clear() {
    preview = null
    result = null
    progress = 0f
  }
}

internal val LocalPrototypeBackSeek = compositionLocalOf<PrototypeBackSeek?> { null }
internal val LocalPrototypeStackScrollStores =
  compositionLocalOf<PrototypeStackScrollStores?> { null }
internal val LocalPrototypeStackRuntime = compositionLocalOf<PrototypeRuntime?> { null }
internal val LocalPrototypeStackSnapshot = compositionLocalOf<PrototypeRuntimeSnapshot?> { null }

private data class ScrollEntry(
  val store: PrototypeStackScrollStore,
  val position: Int,
  val screen: String,
)

private val LocalStackScrollEntry = compositionLocalOf<ScrollEntry?> { null }

@Composable
internal fun rememberStackScrollState(identity: String): ScrollState {
  val entry = LocalStackScrollEntry.current
  val state = rememberScrollState(entry?.store?.read(entry.position, entry.screen, identity) ?: 0)
  if (entry != null) {
    LaunchedEffect(state, entry, identity) {
      snapshotFlow { state.value }
        .collect { entry.store.save(entry.position, entry.screen, identity, it) }
    }
  }
  return state
}

private data class StackFrame(
  val position: Int,
  val screen: String,
  val node: PrototypeRenderNode,
) {
  val key: Pair<Int, String>
    get() = position to screen
}

@Composable
internal fun PrototypeStackContent(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as PrototypeStackNode
  val snapshot = LocalPrototypeStackSnapshot.current
  val path = snapshot?.stacks?.get(source.id)?.path ?: listOf(source.start)
  val child = node.children.firstOrNull() ?: return
  val frame = StackFrame(path.lastIndex, path.last(), child)
  val store =
    LocalPrototypeStackScrollStores.current?.get(source.id)
      ?: remember(source.id, LocalPrototypeShowEpoch.current) { PrototypeStackScrollStore() }
  store.retain(path)
  val change =
    (LocalPrototypeBackSeek.current?.preview ?: snapshot)?.stackChange?.takeIf {
      it.id == source.id
    }
  val seek = LocalPrototypeBackSeek.current
  val runtime = LocalPrototypeStackRuntime.current
  val preview = seek?.preview?.takeIf { it.stackChange?.id == source.id }
  val animation =
    resolveStackAnimation(
      source.stackTransition,
      change,
      LocalPrototypeMotion.current,
      LocalPrototypeReducedMotion.current,
    )
  val rtl = prototypeRtl()
  val draw: @Composable (StackFrame, Boolean) -> Unit = { screen, settled ->
    StackScreen(screen, store, settled, interact)
  }
  val previous = remember { mutableStateOf(frame) }
  SideEffect { previous.value = frame }
  if (preview == null) {
    OrdinaryStackContent(frame, modifier, animation, rtl, node.style.alignment, draw)
  } else {
    SeekableStackContent(
      previous.value,
      frame,
      preview,
      runtime,
      seek,
      modifier,
      animation.kind,
      rtl,
      node.style.alignment,
      draw,
    )
  }
}

@Composable
private fun OrdinaryStackContent(
  frame: StackFrame,
  modifier: Modifier,
  animation: StackAnimation,
  rtl: Boolean,
  alignment: Alignment,
  draw: @Composable (StackFrame, Boolean) -> Unit,
) {
  // Retain the transition across instant actions so the next animated pop starts at that screen.
  val transition = updateTransition(frame, label = "prototype stack")
  if (animation.kind == StackTransitionKind.None)
    Box(modifier, contentAlignment = alignment) { key(frame.key) { draw(frame, true) } }
  else {
    transition.AnimatedContent(
      modifier,
      transitionSpec = {
        stackTransform(animation.kind, animation.direction, rtl, animation.fadeThrough)
      },
      contentKey = { it.key },
      contentAlignment = alignment,
    ) { screen ->
      draw(screen, !transition.isRunning && transition.currentState.key == screen.key)
    }
  }
}

@Composable
private fun StackScreen(
  screen: StackFrame,
  store: PrototypeStackScrollStore,
  settled: Boolean,
  interact: (PrototypeInteraction) -> Unit,
) {
  val focus = remember { FocusRequester() }
  LaunchedEffect(screen.key, settled) { if (settled) focus.requestFocus() }
  CompositionLocalProvider(
    LocalStackScrollEntry provides ScrollEntry(store, screen.position, screen.screen),
  ) {
    Box(Modifier.semantics { paneTitle = screen.screen }.focusRequester(focus).focusable()) {
      RenderPrototypeNode(screen.node, interact)
    }
  }
}

@Composable
@Suppress("LongParameterList")
private fun SeekableStackContent(
  initial: StackFrame,
  frame: StackFrame,
  preview: PrototypeRuntimeSnapshot?,
  runtime: PrototypeRuntime?,
  seek: PrototypeBackSeek,
  modifier: Modifier,
  kind: StackTransitionKind,
  rtl: Boolean,
  alignment: Alignment,
  draw: @Composable (StackFrame, Boolean) -> Unit,
) {
  val state = remember { SeekableTransitionState(initial) }
  val transition = rememberTransition(state, label = "prototype back")
  val target =
    remember(preview, frame) {
      if (preview == null || runtime == null) frame
      else {
        val id = checkNotNull(preview.stackChange).id
        fun find(node: PrototypeRenderNode): PrototypeRenderNode? =
          if ((node.source as? PrototypeStackNode)?.id == id) node
          else node.children.firstNotNullOfOrNull(::find)
        val stack = find(runtime.renderModel(preview).root)
        val path = preview.stacks.getValue(id).path
        stack?.children?.firstOrNull()?.let { StackFrame(path.lastIndex, path.last(), it) } ?: frame
      }
    }
  LaunchedEffect(frame, target, preview, seek.progress, seek.result, kind) {
    if (preview == null) {
      if (kind == StackTransitionKind.None) state.snapTo(frame) else state.animateTo(frame)
    } else
      when (seek.result) {
        null -> if (kind != StackTransitionKind.None) state.seekTo(seek.progress, target)
        true -> {
          if (kind == StackTransitionKind.None) state.snapTo(target) else state.animateTo(target)
          seek.clear()
        }
        false -> {
          if (kind == StackTransitionKind.None) state.snapTo(frame) else state.animateTo(frame)
          seek.clear()
        }
      }
  }
  transition.AnimatedContent(
    modifier,
    transitionSpec = { stackTransform(kind, "pop", rtl) },
    contentKey = { it.key },
    contentAlignment = alignment,
  ) {
    draw(it, !transition.isRunning && state.currentState.key == it.key)
  }
}

private fun stackTransform(
  kind: StackTransitionKind,
  direction: String,
  rtl: Boolean,
  fadeThrough: Boolean = false,
): ContentTransform {
  val timing = tween<Float>(STACK_DURATION_MS, easing = LinearOutSlowInEasing)
  return when (kind) {
    StackTransitionKind.None -> EnterTransition.None togetherWith ExitTransition.None
    StackTransitionKind.Fade ->
      if (fadeThrough) {
        fadeIn(tween(STACK_FADE_THROUGH_MS, delayMillis = STACK_FADE_THROUGH_MS)) togetherWith
          fadeOut(tween(STACK_FADE_THROUGH_MS))
      } else fadeIn(timing) togetherWith fadeOut(timing)
    StackTransitionKind.Slide -> {
      val pop = direction == "pop"
      val slideTiming =
        tween<androidx.compose.ui.unit.IntOffset>(STACK_DURATION_MS, easing = LinearOutSlowInEasing)
      (slideInHorizontally(slideTiming) { width ->
          stackEnterOffset(width, pop, rtl)
        } togetherWith
          slideOutHorizontally(slideTiming) { width ->
            stackExitOffset(width, pop, rtl)
          })
        .apply { targetContentZIndex = if (pop) -1f else 1f }
    }
  }.let { transform ->
    ContentTransform(
      transform.targetContentEnter,
      transform.initialContentExit,
      transform.targetContentZIndex,
      sizeTransform = null,
    )
  }
}
