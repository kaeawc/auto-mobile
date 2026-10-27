package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.gestures.snapping.SnapPosition
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerScope
import androidx.compose.foundation.pager.VerticalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActionScope
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.center
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.DefaultShadowColor
import androidx.compose.ui.graphics.LinearGradientShader
import androidx.compose.ui.graphics.RadialGradientShader
import androidx.compose.ui.graphics.Shader
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.takeOrElse
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.*
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsPropertyReceiver
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.protocol.*
import kotlin.math.hypot
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.distinctUntilChanged

/** Per-key epochs of the controller-held text; a field adopts the shown value when its moves. */
internal val LocalPrototypeTextEpochs = compositionLocalOf<Map<String, Int>> { emptyMap() }

internal val LocalPrototypeCompositionProbe = staticCompositionLocalOf<((String) -> Unit)?> { null }

/** Renderer work a test can count; see [LocalPrototypeRenderWorkProbe]. */
internal enum class PrototypeRenderWork {
  /** A container composed with the size-animation modifier applied. Key: node identity. */
  SIZE_ANIMATION,
  /** An image node composed through `BoxWithConstraints` (a subcomposition). Key: node identity. */
  IMAGE_SUBCOMPOSITION,
  /** A decoded image handed to a new painter. Key: asset id. */
  IMAGE_BITMAP_WRAP,
  /** A coroutine launched to load an image. Key: asset id. */
  IMAGE_LOAD_LAUNCH,
  /** An icon name resolved by `prototypeIcon` for an `icon` node. Key: node identity. */
  ICON_LOOKUP,
}

/** Null outside tests, like [LocalPrototypeCompositionProbe]. */
internal val LocalPrototypeRenderWorkProbe =
  staticCompositionLocalOf<((PrototypeRenderWork, String) -> Unit)?> { null }

internal val PrototypeRole = SemanticsPropertyKey<String>("PrototypeRole")

/** Font assets are remembered once per distinct authored family, outside the string builder. */
@Composable
private fun prototypeAnnotatedText(
  spans: List<PrototypeRenderSpan>,
  interact: (PrototypeInteraction) -> Unit,
): AnnotatedString {
  val families = mutableMapOf<PrototypeFontFamily, FontFamily>()
  for (span in spans.distinctBy { it.style.source.fontFamily }) {
    val family = span.style.source.fontFamily ?: continue
    key(family) { families[family] = rememberPrototypeFontFamily(span.style) }
  }
  val styles = spans.map { span ->
    val rendered = span.style
    val source = rendered.source
    SpanStyle(
      color = prototypeThemedColor(rendered.color, source.color) ?: rendered.color,
      background =
        prototypeThemedColor(rendered.background, source.background) ?: Color.Unspecified,
      fontSize = source.textSize?.toFloat()?.sp ?: TextUnit.Unspecified,
      fontWeight = if (source.fontWeight != null) rendered.fontWeight else null,
      fontStyle = if (source.fontStyle != null) rendered.fontStyle else null,
      textDecoration = if (source.textDecoration != null) rendered.textDecoration else null,
      letterSpacing = source.letterSpacing?.toFloat()?.sp ?: TextUnit.Unspecified,
      fontFamily = source.fontFamily?.let { families[it] },
    )
  }
  return buildAnnotatedString {
    spans.forEachIndexed { index, span ->
      val start = length
      append(span.text)
      addStyle(styles[index], start, length)
      span.onTap?.let { actions ->
        addLink(
          LinkAnnotation.Clickable(
            tag = "span-$index",
            styles = null,
            linkInteractionListener = { interact(PrototypeInteraction.Tap(actions)) },
          ),
          start,
          length,
        )
      }
    }
  }
}

internal val LocalPrototypeShaderSession = compositionLocalOf<PrototypeShaderSession?> { null }

/** Compose owns gesture mechanics only; all authored state/actions go through the pure runtime. */
@Composable
@InternalAutoMobilePrototypeApi
fun PrototypeRuntimeContent(
  runtime: PrototypeRuntime,
  images: PrototypeImageCache? = null,
  fonts: PrototypeFontCache? = null,
  interact: suspend (PrototypeInteraction) -> Unit,
) {
  val snapshot by runtime.snapshots.collectAsState()
  val imageVersion = images?.version?.collectAsState()?.value
  val resolver = LocalContext.current.contentResolver
  val durationScale by rememberAnimatorDurationScale(resolver)
  val transitionScale by rememberTransitionAnimationScale(resolver)
  val profile = prototypeMotionProfile(snapshot.spec.motion, durationScale, transitionScale)
  val motion = profile != PrototypeMotionProfile.OFF
  if (snapshot.active) {
    key(runtime) {
      // One ordered queue drained by one coroutine: interactions reach the controller exactly in
      // the order they happened, whatever the dispatcher does with separately launched jobs.
      val queue = remember { Channel<PrototypeInteraction>(Channel.UNLIMITED) }
      LaunchedEffect(queue) { for (interaction in queue) interact(interaction) }
      val send =
        remember(queue) {
          { interaction: PrototypeInteraction ->
            queue.trySend(interaction)
            Unit
          }
        }
      val scrollStores = remember { PrototypeStackScrollStores() }
      scrollStores.retain(snapshot.stacks.mapValues { it.value.path })
      CompositionLocalProvider(
        LocalPrototypeListEndTriggers provides runtime.listEndTriggers,
        LocalPrototypeStackScrollStores provides scrollStores,
        LocalPrototypeTextEpochs provides snapshot.textEpochs,
        LocalPrototypeScrollRequests provides snapshot.scrollRequests,
        LocalPrototypeImageCache provides images,
        LocalPrototypeImageVersion provides imageVersion,
        LocalPrototypeFontCache provides fonts,
        LocalPrototypeShaderSession provides runtime.shaderSession,
        LocalPrototypeMotion provides motion,
        LocalPrototypeScrollReduced provides (snapshot.spec.motion == "reduced"),
        LocalPrototypeMotionProfile provides profile,
        LocalPrototypeMotionActivity provides runtime.motionActivity,
        LocalPrototypeEffectHealth provides runtime.effectHealth,
        LocalPrototypeStackRuntime provides runtime,
        LocalPrototypeStackSnapshot provides snapshot,
        LocalPrototypeSwipeCoordinator provides
          (LocalPrototypeSwipeCoordinator.current ?: remember { SwipeCoordinator() }),
      ) {
        val traceSink = PrototypeTrace.sink
        val traceEnabled = traceSink.isEnabled()
        if (traceEnabled) traceSink.begin(PrototypeTrace.COMPOSE)
        ObservePrototypeDevice(send)
        PrototypeSpecContent(
          runtime.renderModel(snapshot).root,
          snapshot.spec.theme,
          deadTaps = snapshot.spec.window.deadTaps == true,
          interact = send,
        )
        if (traceEnabled) traceSink.end()
      }
    }
  }
}

/** The open dropdown's options, closed again when a newly opened modal hides its select. */
@Composable
private fun PrototypeExpandedSelect(
  root: PrototypeRenderNode,
  modals: List<PrototypeRenderNode>,
  menuLayers: PrototypeMenuLayers,
  interact: (PrototypeInteraction) -> Unit,
) {
  val expanded = menuLayers.expandedSelect
  val select = expanded?.let { identity ->
    visiblePrototypeSelect(root, identity)?.takeIf {
      // A newly opened modal closes a dropdown on the page behind it.
      modals.none { modal -> modal.role == "dialog" || modal.role == "menu" } ||
        modals.any { modal -> visiblePrototypeSelect(modal, identity) != null }
    }
  }
  if (select != null) RenderPrototypeSelectOptions(select, interact)
  else if (expanded != null) SideEffect { menuLayers.expandedSelect = null }
}

@Composable
private fun prototypeContentLocals(
  root: PrototypeRenderNode,
  scrollOffsets: PrototypeScrollOffsets,
  anchorLocals: PrototypeAnchorLocals,
  menuLayers: PrototypeMenuLayers,
  gestureTaps: PrototypeGestureTaps,
): Array<ProvidedValue<*>> =
  arrayOf(
    LocalPrototypeListEndTriggers provides
      (LocalPrototypeListEndTriggers.current
        ?: remember(LocalPrototypeShowEpoch.current) { PrototypeListEndTriggers() }),
    LocalPrototypeScrollOffsets provides scrollOffsets,
    LocalPrototypeBarScroll provides rememberPrototypeBarScroll(root),
    LocalPrototypeAnchorLocals provides anchorLocals,
    LocalPrototypeShaderSession provides
      (LocalPrototypeShaderSession.current ?: remember { PrototypeShaderSession() }),
    LocalPrototypeGestureTaps provides gestureTaps,
    LocalPrototypeMenuLayers provides menuLayers,
    LocalPrototypeDrawerLayers provides remember { PrototypeDrawerLayers() },
    LocalPrototypeTooltipTargets provides remember(root) { prototypeTooltipTargets(root) },
    LocalPrototypeTargetFocus provides remember { mutableMapOf() },
    LocalPrototypeRetainedSubtrees provides remember(root) { prototypeRetainedSubtrees(root) },
    LocalPrototypeHandleVisuals provides remember(root) { prototypeHandleVisuals(root) },
  )

@OptIn(ExperimentalComposeUiApi::class)
@Composable
@InternalAutoMobilePrototypeApi
fun PrototypeSpecContent(
  root: PrototypeRenderNode,
  theme: PrototypeSpecTheme? = null,
  deadTaps: Boolean = false,
  interact: (PrototypeInteraction) -> Unit = {},
) {
  PrototypeTheme(root, theme) {
    PrototypeSharedRoot(root) {
      val gestureTaps = remember { PrototypeGestureTaps() }
      val density = LocalDensity.current.density
      val currentInteract = rememberUpdatedState(interact)
      val scrollOffsets = remember { PrototypeScrollOffsets() }
      scrollOffsets.targets = remember(root) { prototypeScrollTargets(root) }
      val anchorLocals = remember { PrototypeAnchorLocals() }
      val menuLayers = remember { PrototypeMenuLayers() }
      val menuParents = remember(root) { prototypeMenuParents(root) }
      CompositionLocalProvider(
        *prototypeContentLocals(root, scrollOffsets, anchorLocals, menuLayers, gestureTaps),
      ) {
        PrototypeShaderFrameSampling(checkNotNull(LocalPrototypeShaderSession.current))
        Box(
          Modifier.then(
              if (deadTaps)
                Modifier.prototypeDeadTapObserver(gestureTaps, density) {
                  currentInteract.value(it)
                }
              else Modifier,
            )
            .onGloballyPositioned { menuLayers.windowBounds = it.boundsInRoot() }
            .semantics { testTagsAsResourceId = true },
        ) {
          val modals = prototypeModalLayers(root)
          PrototypeModalPage(modals) {
            RenderPrototypeNode(root, interact, windowRoot = true)
            PrototypeAnchorLayer(remember(root) { layeredPrototypeAnchors(root) }, interact)
          }
          modals.forEach { node ->
            key(node.identity) {
              if (node.role == "menu") {
                val parent = menuParents[node.identity]
                RenderPrototypeMenu(
                  node,
                  Modifier.prototypeShader(node).then(prototypeNodeModifier(node, interact)),
                  parent?.let { menuLayers.bounds[it] } ?: menuLayers.windowBounds,
                  interact,
                )
              } else RenderPrototypeModal(node, interact)
              PrototypeAnchorLayer(
                remember(node) { layeredPrototypeAnchorsIn(node.children) },
                interact,
              )
            }
          }
          PrototypeExpandedSelect(root, modals, menuLayers, interact)
        }
      }
    }
  }
}

/**
 * True where the prototype content sits in a window that already covers the screen (fullscreen
 * placement), so [fillWhenEmpty] cannot change what the window occupies. False for floating and
 * sheet windows, which wrap their content: filling there would grow the window over the app, which
 * it would then block from touches and from `observe`.
 */
@InternalAutoMobilePrototypeApi val LocalPrototypeFillsWindow = compositionLocalOf { false }

/**
 * Gives a content box that measured empty the whole bounded space it was offered. A root whose
 * children are all anchored (#10814) measures 0x0 because the anchor layer takes no space, and
 * Compose clips every descendant's accessibility bounds to its ancestors, so the anchored nodes
 * reported empty, invisible bounds and `observe` dropped them (#10870). A non-empty box keeps its
 * measured size. Apply only inside a window that is already full-size
 * ([LocalPrototypeFillsWindow]).
 */
internal fun Modifier.fillWhenEmpty(): Modifier = layout { measurable, constraints ->
  val placeable = measurable.measure(constraints)
  val width =
    if (placeable.width == 0 && constraints.hasBoundedWidth) constraints.maxWidth
    else placeable.width
  val height =
    if (placeable.height == 0 && constraints.hasBoundedHeight) constraints.maxHeight
    else placeable.height
  layout(width, height) { placeable.place(0, 0) }
}

/**
 * The CompositionLocals in force where each anchored node was authored, by node identity (#10803).
 * The anchored node is drawn in a window-level layer, away from the card (or other provider) it
 * sits in, so it is composed with these again: Material's content colour, content alpha and text
 * style would otherwise reset to the window's defaults.
 */
internal class PrototypeAnchorLocals {
  val byIdentity = mutableStateMapOf<String, CapturedAnchor>()
}

/** What an anchored node takes from where it was authored: its locals and its ancestors' fade. */
internal class CapturedAnchor(
  val locals: CompositionLocalContext,
  val fade: () -> Float,
  /** The capture call site that wrote this entry; only it may remove the entry (#10913). */
  val owner: Any = Unit,
)

private val LocalPrototypeAnchorLocals = compositionLocalOf<PrototypeAnchorLocals?> { null }

/**
 * Records the locals at an anchored node's authored position, where the node itself is not drawn.
 */
@Composable
private fun CaptureAnchorLocals(identity: String) {
  val registry = LocalPrototypeAnchorLocals.current ?: return
  // Written while composing, not in an effect: the layer composes after this in the same pass and
  // must not draw the node a frame with the wrong locals first.
  val owner = remember { Any() }
  registry.byIdentity[identity] =
    CapturedAnchor(currentCompositionLocalContext, LocalPrototypeAnchorFade.current, owner)
  DisposableEffect(registry, identity, owner) {
    onDispose {
      // A re-registration from another call site (the motion branch flipping) composes before
      // this one disposes and has already replaced the entry: removing it would hide the node.
      if (registry.byIdentity[identity]?.owner === owner) registry.byIdentity.remove(identity)
    }
  }
}

@Composable
private fun WithAnchorLocals(identity: String, content: @Composable () -> Unit) {
  val captured = LocalPrototypeAnchorLocals.current?.byIdentity?.get(identity)
  if (captured != null) CompositionLocalProvider(captured.locals, content = content) else content()
}

/**
 * Draws [nodes], the anchored nodes of the content below it, above that content and at window level
 * (#10803). Drawn inside their parents, a wrap-content parent clipped them to its slot and reserved
 * that slot for them. The layer takes no space of its own, measures each node against the whole
 * space the prototype content is given (not its parent's slot) and places it at the layer's origin,
 * from which [prototypeAnchor] moves it, touch target and semantics included, onto its anchor. Only
 * the window and the host's content viewport clip it.
 */
@Composable
private fun PrototypeAnchorLayer(
  anchors: List<LayeredPrototypeAnchor>,
  interact: (PrototypeInteraction) -> Unit,
) {
  if (anchors.isEmpty()) return
  Layout(
    content = {
      anchors.forEach { anchor ->
        key(anchor.node.identity) { LayeredAnchorEntry(anchor, interact) }
      }
    },
  ) { measurables, constraints ->
    val loose = constraints.copy(minWidth = 0, minHeight = 0)
    val placeables = measurables.map { it.measure(loose) }
    layout(constraints.minWidth, constraints.minHeight) { placeables.forEach { it.place(0, 0) } }
  }
}

/**
 * One anchored node of the layer, composed with the locals of its authored position. While an
 * ancestor with a `visibleWhen` hides, the node stays composed until that ancestor's exit has
 * finished and fades with it (its alpha is the ancestors' exit progress, #10869); it fades in with
 * them again. Without motion, or with no animated ancestor, it follows them instantly. Only a fade:
 * a shrink would clip the node to the layer's zero-size slot, not to the ancestor it was authored
 * in.
 */
@Composable
private fun LayeredAnchorEntry(
  anchor: LayeredPrototypeAnchor,
  interact: (PrototypeInteraction) -> Unit,
) {
  val node = anchor.node
  val content: @Composable () -> Unit = {
    WithAnchorLocals(node.identity) { RenderPrototypeNode(node, interact, anchorLayer = true) }
  }
  if (LocalPrototypeMotion.current && anchor.animatedAncestor != null) {
    // Composed exactly while the authored ancestors are: their exit keeps them (and so this) up
    // until it finishes, and their fade, not a transition of our own, drives the alpha (#10869).
    val captured = LocalPrototypeAnchorLocals.current?.byIdentity?.get(node.identity)
    if (captured != null) Box(Modifier.anchorFade(captured.fade)) { content() }
  } else if (anchor.ancestorsShown) content()
}

@Composable
private fun RenderPrototypeModal(
  node: PrototypeRenderNode,
  interact: (PrototypeInteraction) -> Unit,
) {
  val boundsModifier = Modifier.prototypeTargetBounds(node)
  val modifier = boundsModifier.prototypeShader(node).then(prototypeNodeModifier(node, interact))
  when (node.role) {
    "dialog" ->
      RenderPrototypeDialog(node, modifier, interact) {
        node.children.forEach {
          key(it.identity) {
            RenderPrototypeNode(
              it,
              interact,
              columnWeight(it),
              it.weightAxis(PrototypeWeightAxis.VERTICAL),
            )
          }
        }
      }
    "tooltip" -> RenderPrototypeTooltip(node, modifier, interact)
    "drawer" -> RenderPrototypeDrawer(node, modifier, interact)
    "snackbar" -> RenderPrototypeSnackbar(node, modifier, interact)
    else -> RenderPrototypeSheet(node, modifier, interact)
  }
}

/**
 * The largest scroll viewport an unbounded parent can hand a nested same-axis scroll. Compose
 * rejects a scroll measured with an infinite maximum along its axis, which is what a `scroll`
 * inside a `scroll` gets. Capping it gives the inner viewport its content's size, so it has nothing
 * of its own to scroll and the ancestor scrolls it; a bounded viewport passes through unchanged.
 * 32766 px fits Compose's packed constraints whenever the cross axis is at most 65534 px.
 */
internal const val NESTED_SCROLL_VIEWPORT_MAX_PX = 32_766

internal fun Modifier.boundedScrollViewport(vertical: Boolean): Modifier =
  layout { measurable, constraints ->
    val bounded = if (vertical) constraints.hasBoundedHeight else constraints.hasBoundedWidth
    val viewport =
      when {
        bounded -> constraints
        vertical ->
          constraints.copy(maxHeight = maxOf(constraints.minHeight, NESTED_SCROLL_VIEWPORT_MAX_PX))
        else ->
          constraints.copy(maxWidth = maxOf(constraints.minWidth, NESTED_SCROLL_VIEWPORT_MAX_PX))
      }
    val placeable = measurable.measure(viewport)
    layout(placeable.width, placeable.height) { placeable.place(0, 0) }
  }

@Composable
@Suppress("LongParameterList") // The shared render entry point; callers pass only what they need.
internal fun RenderPrototypeNode(
  node: PrototypeRenderNode,
  interact: (PrototypeInteraction) -> Unit,
  parentModifier: Modifier = Modifier,
  weightAxis: PrototypeWeightAxis? = null,
  windowRoot: Boolean = false,
  anchorLayer: Boolean = false,
) {
  // An anchored node below the root is drawn by its window's anchor layer, not in its parent.
  if (!windowRoot && !anchorLayer && isLayeredPrototypeAnchor(node)) {
    CaptureAnchorLocals(node.identity)
    return
  }
  if (usesPlainVisibility(node)) {
    RenderPrototypeVisibility(node, interact, parentModifier, weightAxis, windowRoot)
    return
  }
  // Only `visibleWhen` nodes animate; wrapping every node would add a layout to each one.
  if (LocalPrototypeMotion.current && node.source?.visibleWhen != null) {
    // A stack transition controls navigation only; its own visibility uses the defaults.
    val visibilityTransition =
      prototypeVisibilityTransition(
        node.source.transition?.type.takeUnless { node.role == "stack" },
        LocalPrototypeMotionProfile.current,
        shared = node.source.sharedKey != null,
      )
    // The row/column weight rides on the animated container: it is the Row/Column's direct child.
    AnimatedVisibility(
      visible = node.visible,
      modifier = parentModifier,
      enter = prototypeEnterTransition(visibilityTransition, prototypeRtl(), node.enterDelayMs),
      exit = prototypeExitTransition(visibilityTransition, prototypeRtl()),
    ) {
      ReportPrototypeMotion { transition.isRunning }
      ProvideAnchorFade(
        none = visibilityTransition == "none",
        enterDelayMs = node.enterDelayMs,
      ) {
        RenderPrototypeNodeContentWithViewport(
          node,
          interact,
          Modifier.prototypeSharedBounds(node, this)
            .prototypeBlurReplace(this, visibilityTransition, node.enterDelayMs),
          weightAxis,
          windowRoot,
        )
      }
    }
  } else if (node.visible) {
    RenderPrototypeNodeContentWithViewport(node, interact, parentModifier, weightAxis, windowRoot)
  }
}

private fun usesPlainVisibility(node: PrototypeRenderNode): Boolean {
  val type = node.source?.transition?.type
  return node.role != "stack" &&
    node.source?.visibleWhen != null &&
    (type == "fade" || type == "none")
}

/** The node's visibility transition under the current motion profile. */
@Composable
private fun nodeVisibilityTransition(node: PrototypeRenderNode): String? =
  prototypeVisibilityTransition(
    node.source?.transition?.type,
    LocalPrototypeMotionProfile.current,
    shared = node.source?.sharedKey != null,
  )

@Composable
private fun RenderPrototypeVisibility(
  node: PrototypeRenderNode,
  interact: (PrototypeInteraction) -> Unit,
  parentModifier: Modifier,
  weightAxis: PrototypeWeightAxis?,
  windowRoot: Boolean,
) {
  // Retention membership can change while shown; move the content with its remembered state.
  val currentInteract by rememberUpdatedState(interact)
  val content = remember {
    movableContentOf<PrototypeRenderNode, Modifier, PrototypeWeightAxis?, Boolean> {
      n,
      m,
      axis,
      root ->
      RenderPrototypeNodeContentWithViewport(n, currentInteract, m, axis, root)
    }
  }
  val visibilityTransition = nodeVisibilityTransition(node)
  val history = remember { RetainedVisibilityHistory() }
  if (node.identity in LocalPrototypeRetainedSubtrees.current) {
    PrototypeRetainedVisibility(
      node.visible,
      fade = LocalPrototypeMotion.current && node.source?.transition?.type == "fade",
      history = history,
      modifier = parentModifier,
    ) {
      content(node, Modifier, weightAxis, windowRoot)
    }
    return
  }
  if (node.visible) history.clearSettledHidden()
  CompositionLocalProvider(
    LocalPrototypeShowEpoch provides LocalPrototypeShowEpoch.current + history.epoch,
  ) {
    if (LocalPrototypeMotion.current) {
      AnimatedVisibility(
        visible = node.visible,
        modifier = parentModifier,
        enter =
          prototypeEnterTransition(
            visibilityTransition,
            prototypeRtl(),
            node.enterDelayMs,
          ),
        exit = prototypeExitTransition(visibilityTransition, prototypeRtl()),
      ) {
        ReportPrototypeMotion { transition.isRunning }
        ProvideAnchorFade(
          none = visibilityTransition == "none",
          enterDelayMs = node.enterDelayMs,
        ) {
          content(
            node,
            Modifier.prototypeSharedBounds(node, this)
              .prototypeBlurReplace(this, visibilityTransition, node.enterDelayMs),
            weightAxis,
            windowRoot,
          )
        }
      }
    } else if (node.visible) {
      content(node, parentModifier, weightAxis, windowRoot)
    }
  }
}

@Composable
private fun RenderPrototypeNodeContentWithViewport(
  node: PrototypeRenderNode,
  interact: (PrototypeInteraction) -> Unit,
  parentModifier: Modifier = Modifier,
  weightAxis: PrototypeWeightAxis? = null,
  windowRoot: Boolean = false,
) {
  val repeated =
    when (val source = node.source) {
      is PrototypeBoxNode -> source.repeat != null
      is PrototypeRowNode -> source.repeat != null
      is PrototypeColumnNode -> source.repeat != null
      is PrototypeGridNode -> source.repeat != null
      else -> false
    }
  val ownViewport =
    node.role in listOf("pager", "carousel") ||
      (repeated && LocalPrototypeScrollViewport.current == null)
  if (ownViewport) {
    val parentViewport = LocalPrototypeScrollViewport.current
    val viewport =
      remember(node.identity, parentViewport) {
        PrototypeScrollViewport(node.identity, parentViewport)
      }
    CompositionLocalProvider(LocalPrototypeScrollViewport provides viewport) {
      RenderPrototypeNodeContent(
        node,
        interact,
        parentModifier.onGloballyPositioned { viewport.bounds = it.boundsInRoot() },
        weightAxis,
        windowRoot,
      )
    }
  } else RenderPrototypeNodeContent(node, interact, parentModifier, weightAxis, windowRoot)
}

@Composable
private fun RenderPrototypeNodeContent(
  node: PrototypeRenderNode,
  interact: (PrototypeInteraction) -> Unit,
  parentModifier: Modifier = Modifier,
  weightAxis: PrototypeWeightAxis? = null,
  windowRoot: Boolean = false,
) {
  prototypeSwipeActions(node.source)?.let { swipe ->
    // The row keeps its own layout modifier; the foreground renders as an ordinary node.
    val plain = remember(node) { node.copy(source = prototypeWithoutSwipe(node.source)) }
    PrototypeSwipeRow(node, swipe, interact, parentModifier) {
      RenderPrototypeNodeContentWithViewport(plain, interact, Modifier, weightAxis, windowRoot)
    }
    return
  }
  val traceSink = PrototypeTrace.sink
  val traceEnabled = traceSink.isEnabled()
  if (traceEnabled) traceSink.begin(PrototypeTrace.NODE)
  LocalPrototypeCompositionProbe.current?.invoke(node.identity)
  val boundsModifier = Modifier.prototypeTargetBounds(node)
  val controlInteract: (PrototypeInteraction) -> Unit = { interaction ->
    if (node.source?.enabledCondition() != null)
      interact(PrototypeInteraction.Guarded(node.identity, interaction))
    else interact(interaction)
  }
  var focused by remember(node.identity) { mutableStateOf(false) }
  val focusModifier =
    if (node.source?.checks().isNullOrEmpty()) Modifier
    else
      Modifier.onFocusChanged { focus ->
        if (focused && !focus.hasFocus) {
          controlInteract(PrototypeInteraction.Blur(node.source.checkedKeys()))
        }
        focused = focus.hasFocus
      }
  val modifier =
    (if (node.errorMessage != null && node.role != "textField") Modifier else parentModifier)
      .prototypeScrollAnchor(node.identity)
      .then(boundsModifier)
      .prototypeShader(node)
      .then(prototypeNodeModifier(node, controlInteract, weightAxis, windowRoot))
      .then(focusModifier)
  // Inline layout containers with repeat or a direct visibleWhen child animate and clip their size.
  // Look through card/scroll/pager only; nested layout containers own the animation their parent
  // follows.
  // Others neither spring for text/style/image-load changes nor clip children with motion.
  val animatesSize =
    LocalPrototypeMotion.current &&
      LocalPrototypeMotionProfile.current == PrototypeMotionProfile.FULL &&
      (node.role == "box" ||
        node.role == "row" ||
        node.role == "column" ||
        node.role == "flow" ||
        node.role == "grid") &&
      prototypeContainerAnimatesSize(node)
  val containerModifier = modifier.prototypeAnimateSize(animatesSize)
  if (animatesSize)
    LocalPrototypeRenderWorkProbe.current?.invoke(PrototypeRenderWork.SIZE_ANIMATION, node.identity)
  when (node.role) {
    "box" ->
      Box(containerModifier, contentAlignment = node.style.alignment) {
        node.children.forEach { key(it.identity) { RenderPrototypeNode(it, interact) } }
      }
    "row" ->
      Row(
        containerModifier,
        horizontalArrangement = prototypeHorizontalArrangement(node.style.source),
        verticalAlignment = node.style.verticalAlignment,
      ) {
        node.children.forEach {
          key(it.identity) {
            RenderPrototypeNode(
              it,
              interact,
              rowWeight(it),
              it.weightAxis(PrototypeWeightAxis.HORIZONTAL),
            )
          }
        }
      }
    "column" ->
      Column(
        containerModifier,
        verticalArrangement = prototypeVerticalArrangement(node.style.source),
        horizontalAlignment = node.style.horizontalAlignment,
      ) {
        node.children.forEach {
          key(it.identity) {
            RenderPrototypeNode(
              it,
              interact,
              columnWeight(it),
              it.weightAxis(PrototypeWeightAxis.VERTICAL),
            )
          }
        }
      }
    "flow" ->
      PrototypeFlowLayout(
        containerModifier,
        node.style.source,
        (checkNotNull(node.source) as PrototypeFlowNode).maxLines,
      ) {
        node.children.forEach { key(it.identity) { RenderPrototypeNode(it, interact) } }
      }
    "grid" ->
      PrototypeGridLayout(
        containerModifier,
        (checkNotNull(node.source) as PrototypeGridNode).columns,
        node.style.source,
      ) {
        node.children.forEach {
          key(it.identity) {
            RenderPrototypeNode(it, interact, Modifier.prototypeGridSpan(it.source?.span ?: 1))
          }
        }
      }
    "carousel" ->
      RenderPrototypeCarousel(node, containerModifier) { RenderPrototypeNode(it, interact) }
    "text" -> {
      val source = node.style.source
      val role = prototypeTextRole(MaterialTheme.typography, source.textStyle)
      // A styled text node with no colour of its own reads as on-surface text, not black.
      val textColor =
        if (source.color == null && role != null) MaterialTheme.colorScheme.onSurface
        else
          prototypeAnimatedColor(
            node,
            prototypeThemedColor(node.style.color, source.color) ?: node.style.color,
          )
      if (node.spans == null) {
        Text(
          node.text,
          modifier,
          color = textColor,
          // sp, so prototype text follows the system font scale like the app it prototypes
          // (#10436).
          // A `textStyle` role supplies size, weight and family; explicit style fields still win.
          fontSize =
            source.textSize?.toFloat()?.sp ?: if (role == null) 14.sp else TextUnit.Unspecified,
          fontWeight =
            if (role == null || source.fontWeight != null) node.style.fontWeight else null,
          // Only an authored family overrides; otherwise the text inherits the theme's family
          // through
          // its role or the themed body style, as plain text in the prototyped app would (#10561).
          fontFamily =
            if (source.fontFamily != null) rememberPrototypeFontFamily(node.style) else null,
          // Authored-only, like fontWeight: an unset property keeps what the role or theme gives.
          fontStyle = if (source.fontStyle != null) node.style.fontStyle else null,
          letterSpacing = source.letterSpacing?.toFloat()?.sp ?: TextUnit.Unspecified,
          textDecoration = if (source.textDecoration != null) node.style.textDecoration else null,
          textAlign = node.style.textAlign,
          lineHeight = source.lineHeight?.toFloat()?.sp ?: TextUnit.Unspecified,
          overflow = node.style.overflow,
          maxLines = source.maxLines ?: Int.MAX_VALUE,
          style = role ?: LocalTextStyle.current,
        )
      } else {
        Text(
          prototypeAnnotatedText(node.spans, interact),
          modifier,
          color = textColor,
          // sp, so prototype text follows the system font scale like the app it prototypes
          // (#10436).
          // A `textStyle` role supplies size, weight and family; explicit style fields still win.
          fontSize =
            source.textSize?.toFloat()?.sp ?: if (role == null) 14.sp else TextUnit.Unspecified,
          fontWeight =
            if (role == null || source.fontWeight != null) node.style.fontWeight else null,
          // Only an authored family overrides; otherwise the text inherits the theme's family
          // through
          // its role or the themed body style, as plain text in the prototyped app would (#10561).
          fontFamily =
            if (source.fontFamily != null) rememberPrototypeFontFamily(node.style) else null,
          // Authored-only, like fontWeight: an unset property keeps what the role or theme gives.
          fontStyle = if (source.fontStyle != null) node.style.fontStyle else null,
          letterSpacing = source.letterSpacing?.toFloat()?.sp ?: TextUnit.Unspecified,
          textDecoration = if (source.textDecoration != null) node.style.textDecoration else null,
          textAlign = node.style.textAlign,
          lineHeight = source.lineHeight?.toFloat()?.sp ?: TextUnit.Unspecified,
          overflow = node.style.overflow,
          maxLines = source.maxLines ?: Int.MAX_VALUE,
          style = role ?: LocalTextStyle.current,
        )
      }
    }
    "icon" -> {
      val variant = (node.source as? PrototypeIconNode)?.variant
      val probe = LocalPrototypeRenderWorkProbe.current
      val icon =
        remember(node.iconName, variant) {
          probe?.invoke(PrototypeRenderWork.ICON_LOOKUP, node.identity)
          prototypeIcon(node.iconName, variant)
        }
      if (icon != null)
        Icon(
          icon,
          contentDescription = null,
          modifier = modifier,
          tint =
            prototypeAnimatedColor(
              node,
              (prototypeThemedColor(node.style.color, node.style.source.color) ?: node.style.color)
                .takeOrElse { LocalContentColor.current },
            ),
        )
      else
        Box(
          modifier
            .defaultMinSize(24.dp, 24.dp)
            .background(
              prototypeThemedColor(node.style.background, node.style.source.background)
                ?: prototypePlaceholderColor(MaterialTheme.colorScheme),
            ),
        )
    }
    "image" -> PrototypeImageContent(node, modifier)
    "scroll" -> {
      val scroll = key(LocalPrototypeShowEpoch.current) { rememberStackScrollState(node.identity) }
      RegisterPrototypeScroll(node.identity, scroll)
      val motionViewport = remember { PrototypeScrollViewport() }
      val source = node.source as? PrototypeScrollNode
      val refresh = source?.refresh?.takeIf { source.axis != "horizontal" }
      // A vertical scroll may be a chat list (#14232); reverse anchors it at its end.
      val chat = source?.takeIf { it.axis != "horizontal" }
      val reverse = chat?.reverse == true
      val anchors = remember { PrototypeScrollAnchors() }
      val viewport = Modifier.onGloballyPositioned {
        anchors.viewport = it
        motionViewport.bounds = it.boundsInRoot()
      }
      val scrollModifier = modifier.prototypeBarScroll(node)
      val scrolling =
        if (source?.axis == "horizontal")
          scrollModifier
            .then(viewport)
            .boundedScrollViewport(vertical = false)
            .prototypeFadeEdges(scroll, true, source.fadeEdges)
            .horizontalScroll(scroll)
        else if (refresh != null)
          scrollModifier
            .then(viewport)
            .boundedScrollViewport(vertical = true)
            .prototypeFadeEdges(scroll, false, source.fadeEdges, reverse)
            .verticalScroll(scroll, reverseScrolling = reverse)
        else
          scrollModifier
            .then(viewport)
            .boundedScrollViewport(vertical = true)
            .prototypeFadeEdges(scroll, false, source?.fadeEdges, reverse)
            .verticalScroll(scroll, reverseScrolling = reverse)
      if (chat != null) PrototypeChatScrollEffects(chat, scroll, anchors, interact)
      val content: @Composable BoxScope.() -> Unit = {
        CompositionLocalProvider(
          LocalPrototypeScrollViewport provides motionViewport,
          LocalPrototypeScrollAnchors provides chat?.let { anchors },
        ) {
          node.children.forEach { key(it.identity) { RenderPrototypeNode(it, interact) } }
        }
      }
      if (refresh != null) {
        PrototypeRefreshBox(refresh, node.checked, modifier, interact) {
          Box(scrolling, content = content)
        }
      } else Box(scrolling, content = content)
    }
    "stack" -> PrototypeStackContent(node, modifier, interact)
    "pager" -> RenderPrototypePager(node, modifier, interact)
    "tabBar",
    "bottomNav" -> RenderPrototypeNavigation(node, modifier, interact)
    "bottomSheet",
    "tooltip",
    "drawer",
    "dialog",
    "menu",
    "snackbar" -> Unit // Modal content is hoisted above the whole author tree, within this window.
    "iconButton" -> RenderPrototypeIconButton(node, modifier, controlInteract)
    "fab" -> RenderPrototypeFab(node, modifier, controlInteract)
    "segmentedButton" -> RenderPrototypeSegmentedButton(node, modifier, interact)
    "topAppBar" -> RenderPrototypeTopAppBar(node, modifier, interact)
    "divider" -> RenderPrototypeDivider(node, modifier)
    "badge" -> RenderPrototypeBadge(node, modifier)
    "progress" -> RenderPrototypeProgress(node, modifier)
    "list" ->
      RenderPrototypeLazyList(node, modifier, interact) { RenderPrototypeNode(it, interact) }
    "chart" -> RenderPrototypeChart(node, modifier)
    "timePicker" ->
      PrototypeCheckedControl(node, parentModifier) {
        RenderPrototypeTimePicker(node, modifier, controlInteract)
      }
    "datePicker" ->
      PrototypeCheckedControl(node, parentModifier) {
        RenderPrototypeDatePicker(node, modifier, controlInteract)
      }
    "searchBar" ->
      RenderPrototypeSearchBar(node, modifier, interact) {
        node.children.forEach { child ->
          key(child.identity) {
            RenderPrototypeNode(
              child,
              interact,
              columnWeight(child),
              child.weightAxis(PrototypeWeightAxis.VERTICAL),
            )
          }
        }
      }
    "textField" -> RenderPrototypeTextField(node, modifier, controlInteract)
    "switch",
    "checkbox" ->
      PrototypeCheckedControl(node, parentModifier) {
        RenderPrototypeToggle(node, modifier, controlInteract)
      }
    "button",
    "pasteButton" -> RenderPrototypeButton(node, modifier, controlInteract)
    "radioGroup" ->
      PrototypeCheckedControl(node, parentModifier) {
        RenderPrototypeRadioGroup(node, modifier, controlInteract)
      }
    "select" -> RenderPrototypeSelect(node, modifier)
    "listItem" -> RenderPrototypeListItem(node, modifier, controlInteract)
    "slider" ->
      PrototypeCheckedControl(node, parentModifier) {
        RenderPrototypeSlider(node, modifier, controlInteract)
      }
    "chip" -> RenderPrototypeChip(node, modifier, controlInteract)
    "card" ->
      RenderPrototypeCard(node, modifier) {
        node.children.forEach {
          key(it.identity) {
            RenderPrototypeNode(
              it,
              interact,
              columnWeight(it),
              it.weightAxis(PrototypeWeightAxis.VERTICAL),
            )
          }
        }
      }
    // Spacer keeps its size and authored actions. A spacer with no authored size fills what the
    // parent offers; wrapping to zero collapsed skeleton rows to nothing (#14793).
    "spacer" -> Box(modifier.prototypeSpacerFill(node.style.source))
    else -> Box(modifier)
  }
  if (traceEnabled) traceSink.end()
}

@Composable
private fun RenderPrototypeTextField(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeTextFieldNode ?: return
  RenderPrototypeEditableField(node, source.stateKey, source.onTap.orEmpty(), modifier, interact) {
    shown,
    change,
    fieldModifier,
    presses ->
    val onValueChange: (String) -> Unit = { value ->
      change(prototypeTextFieldClip(value, source.maxLength))
    }
    val label: (@Composable () -> Unit)? = source.label?.let { text -> { Text(text) } }
    val counter = prototypeTextFieldCounter(shown, source.maxLength)
    val supportingText: (@Composable () -> Unit)? =
      if (node.errorMessage != null) {
        { PrototypeErrorCaption(node) }
      } else if (source.supportingText != null || counter != null) {
        {
          Row(Modifier.fillMaxWidth()) {
            Text(source.supportingText.orEmpty(), Modifier.weight(1f))
            if (counter != null) Text(counter)
          }
        }
      } else null
    val ime = prototypeTextFieldImeAction(source.imeAction, !source.onSubmit.isNullOrEmpty())
    val keyboardOptions =
      if (source.keyboardType == null && source.secure != true && ime == ImeAction.Default)
        KeyboardOptions.Default
      else
        KeyboardOptions(
          keyboardType = prototypeTextFieldKeyboardType(source.keyboardType, source.secure),
          imeAction = ime,
        )
    val focus = LocalFocusManager.current
    val submit: KeyboardActionScope.() -> Unit = {
      if (ime == ImeAction.Next) focus.moveFocus(FocusDirection.Next)
      val actions = source.onSubmit.orEmpty()
      if (actions.isNotEmpty()) interact(PrototypeInteraction.Tap(actions))
    }
    val keyboardActions =
      if (ime == ImeAction.Default) KeyboardActions.Default
      else
        KeyboardActions(
          onDone = submit,
          onNext = submit,
          onSearch = submit,
          onSend = submit,
          onGo = submit,
        )
    val leadingIcon: (@Composable () -> Unit)? =
      prototypeIcon(source.leadingIcon)?.let { icon ->
        { Icon(icon, contentDescription = null) }
      }
    val trailingIcon: (@Composable () -> Unit)? =
      source.trailingIcon?.let { action ->
        { PrototypeTextFieldTrailingIcon(node, action, interact) }
      }
    val visualTransformation =
      if (prototypeTextFieldSecure(source.secure, source.keyboardType))
        PasswordVisualTransformation()
      else VisualTransformation.None
    val multiline = source.multiline
    // Omit line options for legacy fields: Compose's default is a growing field.
    if (source.variant == "outlined") {
      if (multiline == null) {
        OutlinedTextField(
          value = shown,
          onValueChange = onValueChange,
          modifier = fieldModifier,
          enabled = node.enabled,
          isError = node.isError,
          interactionSource = presses,
          placeholder = { Text(source.placeholder.orEmpty()) },
          label = label,
          supportingText = supportingText,
          keyboardOptions = keyboardOptions,
          keyboardActions = keyboardActions,
          leadingIcon = leadingIcon,
          trailingIcon = trailingIcon,
          visualTransformation = visualTransformation,
        )
      } else {
        OutlinedTextField(
          value = shown,
          onValueChange = onValueChange,
          modifier = fieldModifier,
          enabled = node.enabled,
          isError = node.isError,
          interactionSource = presses,
          placeholder = { Text(source.placeholder.orEmpty()) },
          label = label,
          supportingText = supportingText,
          keyboardOptions = keyboardOptions,
          keyboardActions = keyboardActions,
          leadingIcon = leadingIcon,
          trailingIcon = trailingIcon,
          visualTransformation = visualTransformation,
          singleLine = !multiline,
          minLines = source.minLines ?: 1,
          maxLines = source.maxLines ?: Int.MAX_VALUE,
        )
      }
    } else {
      if (multiline == null) {
        TextField(
          value = shown,
          onValueChange = onValueChange,
          modifier = fieldModifier,
          enabled = node.enabled,
          isError = node.isError,
          interactionSource = presses,
          placeholder = { Text(source.placeholder.orEmpty()) },
          label = label,
          supportingText = supportingText,
          keyboardOptions = keyboardOptions,
          keyboardActions = keyboardActions,
          leadingIcon = leadingIcon,
          trailingIcon = trailingIcon,
          visualTransformation = visualTransformation,
        )
      } else {
        TextField(
          value = shown,
          onValueChange = onValueChange,
          modifier = fieldModifier,
          enabled = node.enabled,
          isError = node.isError,
          interactionSource = presses,
          placeholder = { Text(source.placeholder.orEmpty()) },
          label = label,
          supportingText = supportingText,
          keyboardOptions = keyboardOptions,
          keyboardActions = keyboardActions,
          leadingIcon = leadingIcon,
          trailingIcon = trailingIcon,
          visualTransformation = visualTransformation,
          singleLine = !multiline,
          minLines = source.minLines ?: 1,
          maxLines = source.maxLines ?: Int.MAX_VALUE,
        )
      }
    }
  }
}

/** One edit/reconciliation and action path for every editable prototype field. */
@Composable
internal fun RenderPrototypeEditableField(
  node: PrototypeRenderNode,
  stateKey: String,
  actions: List<PrototypeAction>,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
  field: @Composable (String, (String) -> Unit, Modifier, MutableInteractionSource) -> Unit,
) {
  val presses = remember { MutableInteractionSource() }
  val focus = remember { FocusRequester() }
  // The shown value is local state, updated synchronously by the IME's own edits; the controller
  // is told afterwards. Binding it to node.text would show the controller's lagging echo, so fast
  // commitText input could be applied against a stale value.
  val epoch = LocalPrototypeTextEpochs.current[stateKey] ?: 0
  val sync = remember { PrototypeTextFieldSync(node.text, epoch) }
  var shown by remember { mutableStateOf(sync.text) }
  LaunchedEffect(node.text, epoch) { if (sync.observe(node.text, epoch)) shown = sync.text }
  LaunchedEffect(presses, actions) {
    presses.interactions.collect { press ->
      if (press is PressInteraction.Release && actions.isNotEmpty())
        interact(PrototypeInteraction.Tap(actions))
    }
  }
  var fieldModifier = modifier.focusRequester(focus)
  node.errorMessage?.let { message ->
    fieldModifier = fieldModifier.semantics { error(message) }
  }
  if (node.enabled && actions.isNotEmpty())
    fieldModifier = fieldModifier.semantics {
      onClick {
        focus.requestFocus()
        interact(PrototypeInteraction.Tap(actions))
        true
      }
    }
  field(
    shown,
    { value ->
      if (sync.edit(value)) {
        shown = value
        interact(PrototypeInteraction.TextChange(stateKey, value, sync.epoch))
      }
    },
    fieldModifier,
    presses,
  )
}

/** Retains neighbours only when cross-axis filling and bounded height allow it. */
@Composable
private fun RenderPrototypePager(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypePagerNode ?: return
  val markSelectedPage =
    (source.peek?.start ?: 0.0) > 0.0 ||
      (source.peek?.end ?: 0.0) > 0.0 ||
      source.pageSize is PrototypePagerPageSize.Dp
  val pager = rememberPagerState(initialPage = node.page) { node.children.size }
  val animate =
    LocalPrototypeMotion.current &&
      LocalPrototypeMotionProfile.current == PrototypeMotionProfile.FULL
  ReportPrototypeMotion { pager.isScrollInProgress }
  // Keyed on motion too: turning motion off mid-scroll cancels the animation and snaps to the page.
  // The offset check matters then: past the halfway point currentPage already reads the target.
  LaunchedEffect(node.page, animate) {
    if (pager.currentPage != node.page || pager.currentPageOffsetFraction != 0f) {
      if (animate) pager.animateScrollToPage(node.page) else pager.scrollToPage(node.page)
    }
  }
  LaunchedEffect(pager) {
    snapshotFlow { pager.isScrollInProgress to pager.settledPage }
      .distinctUntilChanged()
      .collect { (scrolling, page) ->
        interact(PrototypeInteraction.PagerMotion(source.id, page, scrolling))
      }
  }
  val fill = prototypePageFill(node.style.source, source.axis, source.pageSize)
  val pageModifier =
    Modifier.then(if (fill.width) Modifier.fillMaxWidth() else Modifier)
      .then(if (fill.height) Modifier.fillMaxHeight() else Modifier)
  var boundedHeight by remember { mutableStateOf(false) }
  val pagerModifier =
    modifier
      .layout { measurable, constraints ->
        if (boundedHeight != constraints.hasBoundedHeight)
          boundedHeight = constraints.hasBoundedHeight
        val placeable = measurable.measure(constraints)
        layout(placeable.width, placeable.height) { placeable.place(0, 0) }
      }
      .then(
        if (source.indicator == "dots") Modifier.pagerIndicator(pager, source.axis == "vertical")
        else Modifier,
      )
  // Preserve the horizontal pager's retention rule; vertical pages fill across the width.
  val keepNeighbours =
    if (source.axis == "vertical") fill.width && boundedHeight else fill.height && boundedHeight
  val pageContent: @Composable PagerScope.(Int) -> Unit = { page ->
    val onScreen by
      remember(pager, page) {
        derivedStateOf {
          pager.layoutInfo.visiblePagesInfo.any { it.index == page }
        }
      }
    Box(
      pageModifier.then(
        when {
          !onScreen -> Modifier.clearAndSetSemantics {}
          markSelectedPage -> Modifier.semantics { selected = page == pager.currentPage }
          else -> Modifier
        },
      ),
    ) {
      RenderPrototypeNode(node.children[page], interact)
    }
  }
  val padding = pagerContentPadding(source.axis, source.peek)
  val size = pagerPageSize(source.pageSize)
  val spacing = pagerPageSpacing(source.pageSpacing)
  if (source.axis == "vertical") {
    VerticalPager(
      pager,
      pagerModifier,
      contentPadding = padding,
      pageSize = size,
      pageSpacing = spacing,
      snapPosition = SnapPosition.Start,
      beyondViewportPageCount = if (keepNeighbours) 1 else 0,
      key = { node.children[it].identity },
      pageContent = pageContent,
    )
  } else {
    HorizontalPager(
      pager,
      pagerModifier,
      contentPadding = padding,
      pageSize = size,
      pageSpacing = spacing,
      snapPosition = SnapPosition.Start,
      beyondViewportPageCount = if (keepNeighbours) 1 else 0,
      key = { node.children[it].identity },
      pageContent = pageContent,
    )
  }
}

private data class PrototypeNavigationScroll(val minimized: Boolean, val modifier: Modifier)

@Composable
private fun prototypeNavigationScroll(
  node: PrototypeRenderNode,
  modifier: Modifier,
): PrototypeNavigationScroll? {
  val source = node.source
  val behavior =
    when (source) {
      is PrototypeTabBarNode -> source.onScroll
      is PrototypeBottomNavNode -> source.onScroll
      else -> null
    }
  val binding = LocalPrototypeBarScroll.current.bars[node.identity]
  val fraction =
    binding?.fraction(LocalPrototypeMotionProfile.current == PrototypeMotionProfile.FULL) ?: 0f
  if (behavior == "hide" && fraction >= 1f) return null
  val minimized = behavior == "minimize" && fraction > 0f
  val barModifier =
    when {
      behavior == "hide" -> modifier.prototypeBarSlide(fraction)
      minimized && source is PrototypeBottomNavNode -> modifier.height(56.dp)
      else -> modifier
    }
  return PrototypeNavigationScroll(minimized, barModifier)
}

@Composable
private fun RenderPrototypeNavigation(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source
  val items: List<PrototypeItem>
  val pager: String?
  val key: String?
  when (source) {
    is PrototypeTabBarNode -> {
      items = source.items
      pager = source.pager
      key = source.stateKey
    }
    is PrototypeBottomNavNode -> {
      items = source.items
      pager = source.pager
      key = source.stateKey
    }
    else -> return
  }
  val scroll = prototypeNavigationScroll(node, modifier) ?: return
  val select: (Int) -> Unit = { index ->
    interact(PrototypeInteraction.Select(pager, key, index, source.onTap.orEmpty()))
  }
  if (source is PrototypeBottomNavNode)
    NavigationBar(scroll.modifier) {
      items.forEachIndexed { index, item ->
        NavigationBarItem(
          node.selection == index,
          { select(index) },
          icon = { PrototypeNavigationIcon(item) },
          label = if (scroll.minimized) null else ({ Text(item.label) }),
          modifier = Modifier.semantics { if (scroll.minimized) contentDescription = item.label },
        )
      }
    }
  else if (source is PrototypeTabBarNode && source.scrollable)
    ScrollableTabRow(node.selection, scroll.modifier) {
      items.forEachIndexed { index, item ->
        PrototypeNavigationTab(item, node.selection == index, scroll.minimized) { select(index) }
      }
    }
  else
    TabRow(node.selection, scroll.modifier) {
      items.forEachIndexed { index, item ->
        PrototypeNavigationTab(item, node.selection == index, scroll.minimized) { select(index) }
      }
    }
}

@Composable
private fun PrototypeNavigationTab(
  item: PrototypeItem,
  selected: Boolean,
  minimized: Boolean,
  select: () -> Unit,
) {
  Tab(
    selected,
    select,
    modifier = Modifier.semantics { if (minimized) contentDescription = item.label },
    text = if (minimized) null else ({ Text(item.label) }),
    icon = { if (item.icon != null || item.image != null) PrototypeNavigationIcon(item) },
  )
}

/**
 * An in-window sheet: no Dialog/extra window, so scrim and gestures stay inside prototype bounds.
 */
@Composable
private fun RenderPrototypeSheet(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeBottomSheetNode ?: return
  if (!node.sheetOpen) return
  BoxWithConstraints(Modifier.fillMaxSize()) {
    val heights = prototypeSheetHeights(source.detents, maxHeight.value.toDouble())
    var height by remember(node.identity, heights) { mutableDoubleStateOf(heights.first()) }
    var drag by remember(node.identity) { mutableDoubleStateOf(0.0) }
    val density = LocalDensity.current.density
    Box(
      Modifier.fillMaxSize()
        .background(
          prototypeThemedScrim(null, source.scrim)
            ?: prototypeSheetScrimFallback(prototypePalette()),
        )
        .clickable { interact(PrototypeInteraction.SheetDismiss(source.openWhen)) },
    )
    Column(
      modifier
        .align(Alignment.BottomCenter)
        .fillMaxWidth()
        .height((height - drag).coerceIn(0.0, maxHeight.value.toDouble()).toFloat().dp)
        .then(
          // The authored background and gradient are already painted by `modifier`; a later opaque
          // fill would cover them, so the surface is only the fallback when neither is authored.
          if (node.style.source.background == null && node.style.source.gradient == null)
            Modifier.background(MaterialTheme.colorScheme.surface)
          else Modifier,
        )
        .pointerInput(heights, height, source.dismissOnSwipe) {
          detectVerticalDragGestures(
            onDragStart = { drag = 0.0 },
            onVerticalDrag = { change, amount ->
              change.consume()
              drag += amount / density
            },
            onDragCancel = { drag = 0.0 },
            onDragEnd = {
              val settled = settlePrototypeSheet(heights, height, drag, source.dismissOnSwipe)
              drag = 0.0
              if (settled == null) interact(PrototypeInteraction.SheetDismiss(source.openWhen))
              else height = settled
            },
          )
        }
        // Consume body taps to keep the scrim from closing the sheet through empty content.
        .clickable {
          if (!source.onTap.isNullOrEmpty())
            interact(PrototypeInteraction.Tap(source.onTap.orEmpty()))
        },
    ) {
      if (source.dragHandle)
        Box(
          Modifier.align(Alignment.CenterHorizontally)
            .padding(8.dp)
            .size(32.dp, 4.dp)
            .background(prototypeHandleColor(MaterialTheme.colorScheme), RoundedCornerShape(2.dp)),
        )
      node.children.forEach {
        key(it.identity) {
          RenderPrototypeNode(
            it,
            interact,
            columnWeight(it),
            it.weightAxis(PrototypeWeightAxis.VERTICAL),
          )
        }
      }
    }
  }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun prototypeNodeModifier(
  node: PrototypeRenderNode,
  interact: (PrototypeInteraction) -> Unit,
  weightAxis: PrototypeWeightAxis? = null,
  windowRoot: Boolean = false,
): Modifier {
  val style = node.style.source
  val actions = node.source?.onTap.orEmpty()
  val tappable = prototypeNodeTappable(node)
  val handleVisual =
    node.semantics == null &&
      (node.role == "icon" || node.role == "image") &&
      node.identity in LocalPrototypeHandleVisuals.current
  val presses = remember { MutableInteractionSource() }
  var modifier: Modifier = if (node.enabled) Modifier else Modifier.semantics { disabled() }
  // Outermost: the anchor fixes where the whole node, offset and touch target included, lands on
  // screen (#9316). The host resolved element anchors to screen dp bounds before sending.
  val anchor = if (node.role == "tooltip") null else node.source?.anchor as? PrototypeBoundsAnchor
  if (anchor != null) {
    modifier = modifier.prototypeAnchor(anchor, currentPrototypeWindowGeometry(), windowRoot)
  }
  // Draw-time offset, scale and rotation, animated with the node's `animate` (#14208).
  modifier = modifier.prototypeStyleTransform(node).prototypeScrollMotion(node)
  // Outside the touch target and drawing, so the whole node (shadow included) shrinks as one.
  val pressScale = style.pressScale
  if (tappable && pressScale != null) {
    modifier = modifier.prototypePressScale(presses, pressScale.toFloat())
  }
  // Outermost, as in Material components: reserves a 48 dp touch target around a smaller node
  // without changing the size it draws at (#10435).
  if (tappable) modifier = modifier.minimumInteractiveComponentSize()
  // A cover anchor sizes the node to the anchor bounds: authored sizes would only wrap or clamp it.
  if (anchor == null || !prototypeAnchorCovers(anchor))
    modifier = authoredSizeModifier(modifier, style, weightAxis)
  modifier = modifier.alpha(prototypeAnimatedAlpha(node))
  val roundedShape =
    prototypeCornerShape(MaterialTheme.shapes, style.cornerRadius ?: PrototypeCornerRadius.Dp(0.0))
  val shape =
    if (style.cornerStyle == "continuous") PrototypeContinuousShape(roundedShape) else roundedShape
  // Before clip/background/border so the shadow is drawn outside the clipped content.
  style.elevation
    ?.takeIf { style.shadows == null }
    ?.let {
      val shadowColor =
        prototypeThemedColor(node.style.shadowColor, style.shadowColor) ?: DefaultShadowColor
      modifier =
        modifier.shadow(it.toFloat().dp, shape, ambientColor = shadowColor, spotColor = shadowColor)
    }
  modifier = modifier.prototypeShadows(style.shadows, shape, inner = false)
  // Effects (#15129): paint over the content undistorted, then the distorting layer around the
  // background and content. Both sit outside the clip and keep to the node's bounds themselves.
  val effects = rememberPrototypeEffectPlan(node)
  val effectElapsed = rememberPrototypeEffectElapsed(effects, node.identity)
  modifier =
    modifier
      .prototypeEffectOverlay(effects, shape, effectElapsed)
      .prototypeEffectLayer(effects, effectElapsed)
  if (style.cornerRadius != null || style.cornerStyle != null) modifier = modifier.clip(shape)
  prototypeThemedColor(node.style.background, style.background)?.let {
    modifier = modifier.background(prototypeAnimatedColor(node, it), shape)
  }
  style.gradient?.let {
    modifier = modifier.background(prototypeGradientBrush(it, prototypePalette()), shape)
  }
  modifier = modifier.prototypeEffectUnderlay(effects, shape)
  // Post-content modifiers nest in reverse painting order: shimmer, border, then inner shadows.
  modifier = modifier.prototypeShadows(style.shadows, shape, inner = true)
  style.border?.let {
    val gradient = it.gradient
    modifier =
      if (gradient != null) {
        modifier.border(
          it.width.toFloat().dp,
          prototypeGradientBrush(gradient, prototypePalette()),
          shape,
        )
      } else {
        val borderColor = prototypeThemedColor(node.style.borderColor, it.color)
        modifier.border(it.width.toFloat().dp, checkNotNull(borderColor), shape)
      }
  }
  modifier = modifier.prototypeShimmer(style.shimmer == true)
  // Click handling and semantics go before the inset and authored padding, so the whole drawn node
  // is tappable, its ripple covers it, and its accessibility bounds are its drawn bounds (#10435).
  val longPress = node.source?.onLongPress?.takeIf { it.isNotEmpty() }
  val doubleTap = node.source?.onDoubleTap?.takeIf { it.isNotEmpty() }
  val gestureTaps = LocalPrototypeGestureTaps.current
  if (tappable) {
    modifier =
      if (actions.isEmpty()) {
        modifier
          .prototypeGestureObserver(
            gestureTaps,
            presses,
            onLongPress = longPress?.let { { interact(PrototypeInteraction.Tap(it)) } },
            onDoubleTap = doubleTap?.let { { interact(PrototypeInteraction.Tap(it)) } },
          )
          .semantics {
            if (longPress != null) {
              onLongClick(label = PROTOTYPE_LONG_PRESS_ACTION_LABEL) {
                interact(PrototypeInteraction.Tap(longPress))
                true
              }
            }
            if (doubleTap != null) {
              customActions =
                listOf(prototypeDoubleTapAction { interact(PrototypeInteraction.Tap(doubleTap)) })
            }
          }
      } else if (longPress != null || doubleTap != null) {
        modifier
          .combinedClickable(
            onClickLabel = node.semantics?.hint,
            enabled = node.enabled,
            interactionSource = presses,
            indication = LocalIndication.current,
            onClick = { gestureTaps.tap { interact(PrototypeInteraction.Tap(actions)) } },
            onLongClickLabel = longPress?.let { PROTOTYPE_LONG_PRESS_ACTION_LABEL },
            onLongClick = longPress?.let { { interact(PrototypeInteraction.Tap(it)) } },
            onDoubleClick = doubleTap?.let { { interact(PrototypeInteraction.Tap(it)) } },
          )
          // combinedClickable exposes the long click to TalkBack but not the double click, whose
          // gesture TalkBack's own double tap replaces (#15123).
          .semantics {
            if (doubleTap != null) {
              customActions =
                listOf(prototypeDoubleTapAction { interact(PrototypeInteraction.Tap(doubleTap)) })
            }
          }
      } else {
        modifier.clickable(
          onClickLabel = node.semantics?.hint,
          enabled = node.enabled,
          interactionSource = presses,
          indication = LocalIndication.current,
        ) {
          gestureTaps.tap { interact(PrototypeInteraction.Tap(actions)) }
        }
      }
  }
  val description =
    prototypeContentDescription(
      node.role,
      node.text,
      node.iconName,
      tappable,
      node.children,
      node.contentDescription,
    ) ?: if (handleVisual) node.role else null
  val state =
    prototypeStateDescription(node.role, node.page, node.children.size, prototypePickerValue(node))
  // A layout container with nothing of its own to report gets no semantics node, so its children
  // join the nearest reporting ancestor, as with Compose's own layouts (#10446).
  val mergedTapLabel =
    if (tappable && node.role in MERGEABLE_TAP_CONTAINERS) {
      remember(node, tappable) { prototypeMergedTapLabel(node, tappable) }
    } else null
  if (mergedTapLabel != null) {
    modifier = modifier.clearAndSetSemantics {
      text = AnnotatedString(mergedTapLabel)
      contentDescription = mergedTapLabel
      this[PrototypeRole] = node.role
      state?.let { stateDescription = it }
      node.testTag?.let { testTag = it }
    }
  } else if (
    node.role != "searchBar" &&
      !isSemanticsFreeContainer(node, tappable, description, state) &&
      (handleVisual || !isDecorativePrototypeVisual(node, tappable))
  ) {
    modifier = modifier.semantics {
      if (
        node.role !in setOf("textField", "searchBar") &&
          node.role !in SEMANTICS_FREE_CONTAINERS &&
          !(node.role == "text" && node.spans != null)
      ) {
        // Rich text keeps Text's own AnnotatedString semantics, including its link annotations.
        text = AnnotatedString(node.text)
      }
      this[PrototypeRole] = node.role
      if (node.role == "icon" || node.role == "image") role = Role.Image
      // Compose has no native role for text or layout containers; the kind travels in
      // PrototypeRole.
      description?.let { contentDescription = it }
      state?.let { stateDescription = it }
      applyPrototypeAuthoredSemantics(node, state)
      node.testTag?.let { testTag = it }
    }
  }
  val insetFloor = LocalPrototypeInsetFloor.current
  node.safeArea?.let { safeArea ->
    var insets: WindowInsets = WindowInsets(0, 0, 0, 0)
    for (type in safeArea.types) {
      insets =
        insets.union(
          when (type) {
            "systemBars" -> WindowInsets.systemBars.union(insetFloor.asComposeInsets())
            "cutout" -> WindowInsets.displayCutout
            "ime" -> WindowInsets.ime
            else -> WindowInsets(0, 0, 0, 0)
          },
        )
    }
    val sides =
      safeArea.edges
        .map { edge ->
          when (edge) {
            "top" -> WindowInsetsSides.Top
            "bottom" -> WindowInsetsSides.Bottom
            "start" -> WindowInsetsSides.Start
            "end" -> WindowInsetsSides.End
            else -> WindowInsetsSides.Start
          }
        }
        .reduce { sides, next -> sides + next }
    modifier = modifier.windowInsetsPadding(insets.only(sides))
  }
  style.padding?.let {
    modifier =
      modifier.padding(
        start = (it.start ?: 0.0).toFloat().dp,
        top = (it.top ?: 0.0).toFloat().dp,
        end = (it.end ?: 0.0).toFloat().dp,
        bottom = (it.bottom ?: 0.0).toFloat().dp,
      )
  }
  return modifier
}

private val SEMANTICS_FREE_CONTAINERS =
  setOf(
    "box",
    "row",
    "column",
    "flow",
    "grid",
    "carousel",
    "scroll",
    "list",
    "pager",
    "stack",
    "spacer",
    "card",
    "divider",
  )

/**
 * Navigation bars are labelled by their tabs, which carry the Tab role and selected state, so their
 * node kind ("tabBar") is never their label (#10446).
 */
private val CHILD_LABELLED_ROLES = setOf("tabBar", "bottomNav")

/**
 * Whether a node is a layout container with nothing to report: no label, text, tap, test tag or
 * state. Such a node is merged away like an unannotated Compose layout instead of appearing in the
 * accessibility tree as an empty wrapper (#10446).
 */
internal fun isSemanticsFreeContainer(
  node: PrototypeRenderNode,
  tappable: Boolean,
  description: String?,
  state: String?,
): Boolean =
  node.semantics == null &&
    node.role in SEMANTICS_FREE_CONTAINERS &&
    !tappable &&
    node.text.isEmpty() &&
    node.testTag == null &&
    description == null &&
    state == null

/** Icon names describe the drawing, not an authored accessibility label. */
internal fun isDecorativePrototypeVisual(node: PrototypeRenderNode, tappable: Boolean): Boolean =
  node.semantics == null &&
    (node.role == "icon" || node.role == "image") &&
    !tappable &&
    node.testTag == null &&
    node.contentDescription.isNullOrEmpty()

private val VISUAL_TEXT_ROLES = setOf("text", "icon", "image")

private val MERGEABLE_TAP_CONTAINERS =
  setOf("box", "row", "column", "flow", "grid", "carousel", "card")

private fun hasTargetableIdentity(child: PrototypeRenderNode): Boolean =
  child.semantics != null || child.testTag != null || !child.contentDescription.isNullOrEmpty()

private fun hasTargetableBehavior(child: PrototypeRenderNode): Boolean =
  child.spans?.any { it.onTap != null } == true ||
    prototypeNodeTappable(child) ||
    child.source?.let { it.visibleWhen != null || it.anchor != null } == true

/** Preserve exact text selectors and every independently targetable descendant. */
internal fun prototypeMergedTapLabel(node: PrototypeRenderNode, tappable: Boolean): String? {
  if (node.semantics != null || !tappable || node.role !in MERGEABLE_TAP_CONTAINERS) return null
  if (node.text.isNotEmpty() || !node.contentDescription.isNullOrEmpty()) return null
  var label: String? = null
  fun visit(child: PrototypeRenderNode): Boolean {
    if (hasTargetableIdentity(child) || hasTargetableBehavior(child)) return false
    when {
      child.role == "text" -> {
        if (label != null || child.text.isEmpty()) return false
        label = child.text
      }
      isDecorativePrototypeVisual(child, tappable = false) -> Unit
      child.role == "spacer" || child.role == "divider" -> Unit
      child.role in MERGEABLE_TAP_CONTAINERS && child.text.isEmpty() -> Unit
      else -> return false
    }
    return child.children.all { visit(it) }
  }
  return if (node.children.all { visit(it) }) label else null
}

/**
 * The accessible label for a prototype node. An authored `contentDescription` wins, then authored
 * text; an icon-only tappable node reads as its icon name, and so does a tappable layout container
 * whose only content is an icon (a FAB). A layout container or navigation bar is never labelled by
 * its node kind ("box", "row", "tabBar") while it has content (#10524, #10608, #10446): its
 * children label it instead. Only a tappable container with no children at all keeps its kind, as
 * nothing else names it. Non-tappable text, icons and images never use their kind as a label;
 * controls and other information-bearing kinds keep that fallback as a selector handle.
 */
internal fun prototypeContentDescription(
  role: String,
  text: String,
  iconName: String?,
  tappable: Boolean,
  children: List<PrototypeRenderNode> = emptyList(),
  authored: String? = null,
): String? =
  when {
    !authored.isNullOrEmpty() -> authored
    text.isNotEmpty() -> text
    (tappable || role in PROTOTYPE_ICON_CONTROL_ROLES) && !iconName.isNullOrEmpty() -> iconName
    role in CHILD_LABELLED_ROLES -> null
    !tappable && role in VISUAL_TEXT_ROLES -> null
    role !in SEMANTICS_FREE_CONTAINERS -> role
    !tappable -> null
    children.isEmpty() -> role
    else -> prototypeIconOnlyLabel(children)
  }

/**
 * The icon name when the only visible content under a container is one named icon, possibly inside
 * plain single-child layout containers; null for any other content.
 */
private fun prototypeIconOnlyLabel(children: List<PrototypeRenderNode>): String? {
  val only = children.filter { it.visible }.singleOrNull() ?: return null
  return when {
    only.role == "icon" -> only.iconName?.takeIf { it.isNotEmpty() }
    only.role in SEMANTICS_FREE_CONTAINERS && only.text.isEmpty() && !prototypeNodeTappable(only) ->
      prototypeIconOnlyLabel(only.children)
    else -> null
  }
}

/**
 * A pager reports its position (`Page 2 of 4`) and a time or date picker its bound [value]
 * (`07:30`, `2026-10-08`); other roles carry no state of their own here.
 */
internal fun prototypeStateDescription(
  role: String,
  page: Int,
  pageCount: Int,
  value: String? = null,
): String? =
  when {
    role == "pager" && pageCount > 0 -> "Page ${page + 1} of $pageCount"
    role == "timePicker" || role == "datePicker" -> value
    else -> null
  }

/** A time picker's bound value as 24-hour `HH:mm`, or a date picker's `YYYY-MM-DD`. */
internal fun prototypePickerValue(node: PrototypeRenderNode): String? =
  when (node.role) {
    "timePicker" -> String.format(java.util.Locale.ROOT, "%02d:%02d", node.hour, node.minute)
    "datePicker" -> node.selectedValue
    else -> null
  }

/**
 * A node with no authored size on the main axis of its Row/Column `weight` ([weighted]) takes the
 * weighted space: wrapping its content there would shrink an empty box to nothing (#10537).
 */
private fun authoredSizeModifier(
  modifier: Modifier,
  style: PrototypeStyle,
  weightAxis: PrototypeWeightAxis?,
): Modifier {
  // Bounds before the authored size: `width`/`height`/`fill` are then coerced into min/max, where
  // the reverse order would clamp the bounds into an already-fixed size instead (#10537).
  var sized = sizeConstraintModifier(modifier, style)
  sized =
    dimensionModifier(
      sized,
      style.width,
      horizontal = true,
      weighted = weightAxis == PrototypeWeightAxis.HORIZONTAL,
    )
  sized =
    dimensionModifier(
      sized,
      style.height,
      horizontal = false,
      weighted = weightAxis == PrototypeWeightAxis.VERTICAL,
    )
  return style.aspectRatio?.let { sized.aspectRatio(it.toFloat()) } ?: sized
}

private fun dimensionModifier(
  modifier: Modifier,
  size: PrototypeDimension?,
  horizontal: Boolean,
  weighted: Boolean = false,
): Modifier =
  when (size) {
    PrototypeDimension.Fill -> if (horizontal) modifier.fillMaxWidth() else modifier.fillMaxHeight()
    is PrototypeDimension.Dp ->
      if (horizontal) modifier.width(size.dp.toFloat().dp)
      else modifier.height(size.dp.toFloat().dp)
    null -> if (weighted) modifier else wrapContent(modifier, horizontal)
    PrototypeDimension.Wrap -> wrapContent(modifier, horizontal)
  }

/**
 * A `spacer` with no authored size fills what its parent offers, so a row holding only a spacer
 * keeps its width (#14793). A spacer sized on one axis is a gap: its other axis wraps, because
 * filling it would stretch the gap's row across the whole column and push its siblings (the
 * doc-example-2 bottom nav) out. A weighted spacer keeps the share its parent hands it, and an
 * unbounded axis (a scroll) still wraps, since fill ignores an infinite maximum.
 */
private fun Modifier.prototypeSpacerFill(style: PrototypeStyle): Modifier =
  if (style.weight == null && style.width == null && style.height == null) fillMaxSize() else this

private fun wrapContent(modifier: Modifier, horizontal: Boolean): Modifier =
  if (horizontal) modifier.wrapContentWidth() else modifier.wrapContentHeight()

/** The main axis a Row/Column child's `weight` fills. */
internal enum class PrototypeWeightAxis {
  HORIZONTAL,
  VERTICAL,
}

/** [axis] when this child carries a `weight`, so its own size on that axis does not wrap. */
private fun PrototypeRenderNode.weightAxis(axis: PrototypeWeightAxis): PrototypeWeightAxis? =
  axis.takeIf {
    style.source.weight != null
  }

/** Child `weight` takes the remaining main-axis space; only meaningful inside a Row. */
private fun RowScope.rowWeight(child: PrototypeRenderNode): Modifier =
  child.style.source.weight?.let { Modifier.weight(it.toFloat()) } ?: Modifier

/** Child `weight` takes the remaining main-axis space; only meaningful inside a Column. */
private fun ColumnScope.columnWeight(child: PrototypeRenderNode): Modifier =
  child.style.source.weight?.let { Modifier.weight(it.toFloat()) } ?: Modifier

/** Applied before width/height so `fill` and `dp` are clamped by the authored min/max. */
private fun sizeConstraintModifier(modifier: Modifier, style: PrototypeStyle): Modifier =
  if (
    style.minWidth == null &&
      style.maxWidth == null &&
      style.minHeight == null &&
      style.maxHeight == null
  )
    modifier
  else
    modifier.sizeIn(
      minWidth = style.minWidth?.toFloat()?.dp ?: Dp.Unspecified,
      minHeight = style.minHeight?.toFloat()?.dp ?: Dp.Unspecified,
      maxWidth = style.maxWidth?.toFloat()?.dp ?: Dp.Unspecified,
      maxHeight = style.maxHeight?.toFloat()?.dp ?: Dp.Unspecified,
    )

/** A shader brush so the gradient line is computed from the node's measured size. */
private fun prototypeGradientBrush(gradient: PrototypeGradient, palette: PrototypePalette): Brush =
  object : ShaderBrush() {
    override fun createShader(size: Size): Shader =
      when (gradient) {
        is PrototypeLinearGradient -> {
          val (colors, positions) = prototypeGradientStops(gradient.stops, palette)
          val (from, to) = prototypeLinearGradientLine(gradient.angle, size.width, size.height)
          LinearGradientShader(from, to, colors, positions)
        }
        is PrototypeRadialGradient -> {
          val (colors, positions) = prototypeGradientStops(gradient.stops, palette)
          RadialGradientShader(size.center, hypot(size.width, size.height) / 2f, colors, positions)
        }
      }
  }

/** Error captions remain separate semantic nodes so their tags are inspectable. */
@Composable
internal fun PrototypeErrorCaption(node: PrototypeRenderNode) {
  node.errorMessage?.let { message ->
    Text(
      message,
      Modifier.semantics { prototypePartTag(node.testTag, "error")?.let { testTag = it } },
      color = MaterialTheme.colorScheme.error,
      style = MaterialTheme.typography.bodySmall,
    )
  }
}

@Composable
private fun PrototypeCheckedControl(
  node: PrototypeRenderNode,
  modifier: Modifier,
  content: @Composable () -> Unit,
) {
  if (node.errorMessage == null) content()
  else
    Column(modifier) {
      content()
      PrototypeErrorCaption(node)
    }
}

/** Shared by ordinary nodes and the search bar's inner editable field. */
internal fun SemanticsPropertyReceiver.applyPrototypeAuthoredSemantics(
  node: PrototypeRenderNode,
  state: String? = null,
) {
  node.semantics?.let { authored ->
    if (authored.heading == true) heading()
    authored.liveRegion?.let {
      liveRegion = if (it == "assertive") LiveRegionMode.Assertive else LiveRegionMode.Polite
    }
    if (authored.group == true) isTraversalGroup = true
    if ("button" in authored.traits.orEmpty()) role = Role.Button
    if ("image" in authored.traits.orEmpty()) role = Role.Image
    if ("selected" in authored.traits.orEmpty()) selected = true
    authored.label?.let { contentDescription = it }
    authored.hint?.let {
      if (!node.source?.onTap.isNullOrEmpty()) onClick(label = it, action = null)
      else stateDescription = listOfNotNull(state, it).joinToString(", ")
    }
  }
}
