package dev.jasonpearson.automobile.ctrlproxy.overlay

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
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
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.protocol.*
import kotlin.math.hypot
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.distinctUntilChanged

/** Per-key epochs of the controller-held text; a field adopts the shown value when its moves. */
internal val LocalOverlayTextEpochs = compositionLocalOf<Map<String, Int>> { emptyMap() }

val OverlayRole = SemanticsPropertyKey<String>("OverlayRole")

/** Compose owns gesture mechanics only; all authored state/actions go through the pure runtime. */
@Composable
internal fun OverlayRuntimeContent(
  runtime: OverlayRuntime,
  images: OverlayImageCache? = null,
  fonts: OverlayFontCache? = null,
  interact: suspend (OverlayInteraction) -> Unit,
) {
  val snapshot by runtime.snapshots.collectAsState()
  val resolver = LocalContext.current.contentResolver
  val durationScale by rememberAnimatorDurationScale(resolver)
  val motion = overlayMotionEnabled(snapshot.spec.motion, durationScale)
  if (snapshot.active) {
    key(runtime) {
      // One ordered queue drained by one coroutine: interactions reach the controller exactly in
      // the order they happened, whatever the dispatcher does with separately launched jobs.
      val queue = remember { Channel<OverlayInteraction>(Channel.UNLIMITED) }
      LaunchedEffect(queue) { for (interaction in queue) interact(interaction) }
      CompositionLocalProvider(
        LocalOverlayTextEpochs provides snapshot.textEpochs,
        LocalOverlayImageCache provides images,
        LocalOverlayFontCache provides fonts,
        LocalOverlayMotion provides motion,
      ) {
        OverlaySpecContent(
          mapOverlaySpec(snapshot.spec, snapshot.pages).root,
          snapshot.spec.theme,
        ) { interaction ->
          queue.trySend(interaction)
        }
      }
    }
  }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun OverlaySpecContent(
  root: OverlayRenderNode,
  theme: OverlaySpecTheme? = null,
  interact: (OverlayInteraction) -> Unit = {},
) {
  OverlayTheme(root, theme) {
    val anchorLocals = remember { OverlayAnchorLocals() }
    CompositionLocalProvider(LocalOverlayAnchorLocals provides anchorLocals) {
      val fillsWindow = LocalOverlayFillsWindow.current
      Box(Modifier.semantics { testTagsAsResourceId = true }) {
        val modals = modalOverlaySheets(root)
        // An open dialog is modal: the page behind it leaves the accessibility tree, as it does
        // on iOS and as touches already do. A snackbar or sheet does not block the page.
        val pageBlocked = modals.any { it.role == "dialog" }
        // The page box takes the fill: it is the root's parent and must measure the window.
        Box(
          Modifier.then(if (fillsWindow) Modifier.fillWhenEmpty() else Modifier)
            .then(if (pageBlocked) Modifier.clearAndSetSemantics {} else Modifier),
        ) {
          RenderOverlayNode(root, interact, windowRoot = true)
          OverlayAnchorLayer(layeredOverlayAnchors(root), interact)
        }
        modals.forEach { node ->
          key(node.identity) {
            RenderOverlayModal(node, interact)
            OverlayAnchorLayer(layeredOverlayAnchorsIn(node.children), interact)
          }
        }
      }
    }
  }
}

/**
 * True where the overlay content sits in a window that already covers the screen (fullscreen
 * placement), so [fillWhenEmpty] cannot change what the window occupies. False for floating and
 * sheet windows, which wrap their content: filling there would grow the window over the app, which
 * it would then block from touches and from `observe`.
 */
internal val LocalOverlayFillsWindow = compositionLocalOf { false }

/**
 * Gives a content box that measured empty the whole bounded space it was offered. A root whose
 * children are all anchored (#10814) measures 0x0 because the anchor layer takes no space, and
 * Compose clips every descendant's accessibility bounds to its ancestors, so the anchored nodes
 * reported empty, invisible bounds and `observe` dropped them (#10870). A non-empty box keeps its
 * measured size. Apply only inside a window that is already full-size ([LocalOverlayFillsWindow]).
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
internal class OverlayAnchorLocals {
  val byIdentity = mutableStateMapOf<String, CapturedAnchor>()
}

/** What an anchored node takes from where it was authored: its locals and its ancestors' fade. */
internal class CapturedAnchor(
  val locals: CompositionLocalContext,
  val fade: () -> Float,
  /** The capture call site that wrote this entry; only it may remove the entry (#10913). */
  val owner: Any = Unit,
)

private val LocalOverlayAnchorLocals = compositionLocalOf<OverlayAnchorLocals?> { null }

/**
 * Records the locals at an anchored node's authored position, where the node itself is not drawn.
 */
@Composable
private fun CaptureAnchorLocals(identity: String) {
  val registry = LocalOverlayAnchorLocals.current ?: return
  // Written while composing, not in an effect: the layer composes after this in the same pass and
  // must not draw the node a frame with the wrong locals first.
  val owner = remember { Any() }
  registry.byIdentity[identity] =
    CapturedAnchor(currentCompositionLocalContext, LocalOverlayAnchorFade.current, owner)
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
  val captured = LocalOverlayAnchorLocals.current?.byIdentity?.get(identity)
  if (captured != null) CompositionLocalProvider(captured.locals, content = content) else content()
}

/**
 * Draws [nodes], the anchored nodes of the content below it, above that content and at window level
 * (#10803). Drawn inside their parents, a wrap-content parent clipped them to its slot and reserved
 * that slot for them. The layer takes no space of its own, measures each node against the whole
 * space the overlay content is given (not its parent's slot) and places it at the layer's origin,
 * from which [overlayAnchor] moves it, touch target and semantics included, onto its anchor. Only
 * the window and the host's content viewport clip it.
 */
@Composable
private fun OverlayAnchorLayer(
  anchors: List<LayeredOverlayAnchor>,
  interact: (OverlayInteraction) -> Unit,
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
  anchor: LayeredOverlayAnchor,
  interact: (OverlayInteraction) -> Unit,
) {
  val node = anchor.node
  val content: @Composable () -> Unit = {
    WithAnchorLocals(node.identity) { RenderOverlayNode(node, interact, anchorLayer = true) }
  }
  if (LocalOverlayMotion.current && anchor.animatedAncestor != null) {
    // Composed exactly while the authored ancestors are: their exit keeps them (and so this) up
    // until it finishes, and their fade, not a transition of our own, drives the alpha (#10869).
    val captured = LocalOverlayAnchorLocals.current?.byIdentity?.get(node.identity)
    if (captured != null) Box(Modifier.anchorFade(captured.fade)) { content() }
  } else if (anchor.ancestorsShown) content()
}

@Composable
private fun RenderOverlayModal(node: OverlayRenderNode, interact: (OverlayInteraction) -> Unit) {
  val modifier = overlayNodeModifier(node, interact)
  when (node.role) {
    "dialog" ->
      RenderOverlayDialog(node, modifier, interact) {
        node.children.forEach {
          RenderOverlayNode(
            it,
            interact,
            columnWeight(it),
            it.weightAxis(OverlayWeightAxis.VERTICAL),
          )
        }
      }
    "snackbar" -> RenderOverlaySnackbar(node, modifier, interact)
    else -> RenderOverlaySheet(node, modifier, interact)
  }
}

@Composable
private fun RenderOverlayNode(
  node: OverlayRenderNode,
  interact: (OverlayInteraction) -> Unit,
  parentModifier: Modifier = Modifier,
  weightAxis: OverlayWeightAxis? = null,
  windowRoot: Boolean = false,
  anchorLayer: Boolean = false,
) {
  // An anchored node below the root is drawn by its window's anchor layer, not in its parent.
  if (!windowRoot && !anchorLayer && isLayeredOverlayAnchor(node)) {
    CaptureAnchorLocals(node.identity)
    return
  }
  // Only `visibleWhen` nodes animate; wrapping every node would add a layout to each one.
  if (LocalOverlayMotion.current && node.source?.visibleWhen != null) {
    // The row/column weight rides on the animated container: it is the Row/Column's direct child.
    AnimatedVisibility(
      visible = node.visible,
      modifier = parentModifier,
      enter = overlayEnterTransition(node.source.transition),
      exit = overlayExitTransition(node.source.transition),
    ) {
      ProvideAnchorFade(none = node.source.transition == "none") {
        RenderOverlayNodeContent(node, interact, weightAxis = weightAxis, windowRoot = windowRoot)
      }
    }
  } else if (node.visible) {
    RenderOverlayNodeContent(node, interact, parentModifier, weightAxis, windowRoot)
  }
}

@Composable
private fun RenderOverlayNodeContent(
  node: OverlayRenderNode,
  interact: (OverlayInteraction) -> Unit,
  parentModifier: Modifier = Modifier,
  weightAxis: OverlayWeightAxis? = null,
  windowRoot: Boolean = false,
) {
  val modifier = parentModifier.then(overlayNodeModifier(node, interact, weightAxis, windowRoot))
  // Containers whose children can appear, disappear or change animate their size with them.
  val containerModifier = modifier.overlayAnimateSize(LocalOverlayMotion.current)
  when (node.role) {
    "box" ->
      Box(containerModifier, contentAlignment = node.style.alignment) {
        node.children.forEach { RenderOverlayNode(it, interact) }
      }
    "row" ->
      Row(
        containerModifier,
        horizontalArrangement = overlayHorizontalArrangement(node.style.source),
        verticalAlignment = node.style.verticalAlignment,
      ) {
        node.children.forEach {
          RenderOverlayNode(
            it,
            interact,
            rowWeight(it),
            it.weightAxis(OverlayWeightAxis.HORIZONTAL),
          )
        }
      }
    "column" ->
      Column(
        containerModifier,
        verticalArrangement = overlayVerticalArrangement(node.style.source),
        horizontalAlignment = node.style.horizontalAlignment,
      ) {
        node.children.forEach {
          RenderOverlayNode(
            it,
            interact,
            columnWeight(it),
            it.weightAxis(OverlayWeightAxis.VERTICAL),
          )
        }
      }
    "text" -> {
      val source = node.style.source
      val role = overlayTextRole(MaterialTheme.typography, source.textStyle)
      // A styled text node with no colour of its own reads as on-surface text, not black.
      val textColor =
        if (source.color == null && role != null) MaterialTheme.colorScheme.onSurface
        else overlayThemedColor(node.style.color, source.color) ?: node.style.color
      Text(
        node.text,
        modifier,
        color = textColor,
        // sp, so overlay text follows the system font scale like the app it prototypes (#10436).
        // A `textStyle` role supplies size, weight and family; explicit style fields still win.
        fontSize =
          source.textSize?.toFloat()?.sp ?: if (role == null) 14.sp else TextUnit.Unspecified,
        fontWeight = if (role == null || source.fontWeight != null) node.style.fontWeight else null,
        // Only an authored family overrides; otherwise the text inherits the theme's family through
        // its role or the themed body style, as plain text in the prototyped app would (#10561).
        fontFamily = if (source.fontFamily != null) rememberOverlayFontFamily(node.style) else null,
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
    "icon" -> {
      val icon = overlayIcon(node.iconName, (node.source as? OverlayIconNode)?.variant)
      if (icon != null)
        Icon(
          icon,
          contentDescription = null,
          modifier = modifier,
          tint =
            (overlayThemedColor(node.style.color, node.style.source.color) ?: node.style.color)
              .takeOrElse { LocalContentColor.current },
        )
      else
        Box(
          modifier
            .defaultMinSize(24.dp, 24.dp)
            .background(
              overlayThemedColor(node.style.background, node.style.source.background)
                ?: Color.LightGray,
            ),
        )
    }
    "image" -> OverlayImageContent(node, modifier)
    "scroll" -> {
      val scroll = rememberScrollState()
      val source = node.source as? OverlayScrollNode
      val scrolling =
        if (source?.axis == "horizontal") modifier.horizontalScroll(scroll)
        else modifier.verticalScroll(scroll)
      Box(scrolling) { node.children.forEach { RenderOverlayNode(it, interact) } }
    }
    "pager" -> RenderOverlayPager(node, modifier, interact)
    "tabBar",
    "bottomNav" -> RenderOverlayNavigation(node, modifier, interact)
    "bottomSheet",
    "dialog",
    "snackbar" -> Unit // Modal content is hoisted above the whole author tree, within this window.
    "iconButton" -> RenderOverlayIconButton(node, modifier, interact)
    "fab" -> RenderOverlayFab(node, modifier, interact)
    "segmentedButton" -> RenderOverlaySegmentedButton(node, modifier, interact)
    "topAppBar" -> RenderOverlayTopAppBar(node, modifier, interact)
    "divider" -> RenderOverlayDivider(node, modifier)
    "badge" -> RenderOverlayBadge(node, modifier)
    "progress" -> RenderOverlayProgress(node, modifier)
    "timePicker" -> RenderOverlayTimePicker(node, modifier, interact)
    "datePicker" -> RenderOverlayDatePicker(node, modifier, interact)
    "textField" -> RenderOverlayTextField(node, modifier, interact)
    "switch",
    "checkbox" -> RenderOverlayToggle(node, modifier, interact)
    "button" -> RenderOverlayButton(node, modifier, interact)
    "radioGroup" -> RenderOverlayRadioGroup(node, modifier, interact)
    "listItem" -> RenderOverlayListItem(node, modifier, interact)
    "slider" -> RenderOverlaySlider(node, modifier, interact)
    "chip" -> RenderOverlayChip(node, modifier, interact)
    "card" ->
      RenderOverlayCard(node, modifier) {
        node.children.forEach {
          RenderOverlayNode(
            it,
            interact,
            columnWeight(it),
            it.weightAxis(OverlayWeightAxis.VERTICAL),
          )
        }
      }
    // Spacer keeps its size and authored actions.
    else -> Box(modifier)
  }
}

@Composable
private fun RenderOverlayTextField(
  node: OverlayRenderNode,
  modifier: Modifier,
  interact: (OverlayInteraction) -> Unit,
) {
  val source = node.source as? OverlayTextFieldNode ?: return
  val presses = remember { MutableInteractionSource() }
  val focus = remember { FocusRequester() }
  val actions = source.onTap.orEmpty()
  // The shown value is local state, updated synchronously by the IME's own edits; the controller
  // is told afterwards. Binding it to node.text would show the controller's lagging echo, so fast
  // commitText input could be applied against a stale value.
  val epoch = LocalOverlayTextEpochs.current[source.stateKey] ?: 0
  val sync = remember { OverlayTextFieldSync(node.text, epoch) }
  var shown by remember { mutableStateOf(sync.text) }
  LaunchedEffect(node.text, epoch) { if (sync.observe(node.text, epoch)) shown = sync.text }
  LaunchedEffect(presses, actions) {
    presses.interactions.collect { press ->
      if (press is PressInteraction.Release && actions.isNotEmpty())
        interact(OverlayInteraction.Tap(actions))
    }
  }
  var fieldModifier = modifier.focusRequester(focus)
  if (actions.isNotEmpty())
    fieldModifier = fieldModifier.semantics {
      onClick {
        focus.requestFocus()
        interact(OverlayInteraction.Tap(actions))
        true
      }
    }
  // Material's editable field supplies SetText semantics and the keyboard input connection.
  TextField(
    shown,
    { value ->
      if (sync.edit(value)) {
        shown = value
        interact(OverlayInteraction.TextChange(source.stateKey, value, sync.epoch))
      }
    },
    modifier = fieldModifier,
    interactionSource = presses,
    placeholder = { Text(source.placeholder.orEmpty()) },
  )
}

@Composable
private fun RenderOverlayPager(
  node: OverlayRenderNode,
  modifier: Modifier,
  interact: (OverlayInteraction) -> Unit,
) {
  val source = node.source as? OverlayPagerNode ?: return
  val pager = rememberPagerState(initialPage = node.page) { node.children.size }
  val animate = LocalOverlayMotion.current
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
        interact(OverlayInteraction.PagerMotion(source.id, page, scrolling))
      }
  }
  val fill = overlayPageFill(node.style.source)
  val pageModifier =
    Modifier.then(if (fill.width) Modifier.fillMaxWidth() else Modifier)
      .then(if (fill.height) Modifier.fillMaxHeight() else Modifier)
  HorizontalPager(pager, modifier) { page ->
    Box(pageModifier) { RenderOverlayNode(node.children[page], interact) }
  }
}

@Composable
private fun RenderOverlayNavigation(
  node: OverlayRenderNode,
  modifier: Modifier,
  interact: (OverlayInteraction) -> Unit,
) {
  val source = node.source
  val items: List<OverlayItem>
  val pager: String?
  val key: String?
  when (source) {
    is OverlayTabBarNode -> {
      items = source.items
      pager = source.pager
      key = source.stateKey
    }
    is OverlayBottomNavNode -> {
      items = source.items
      pager = source.pager
      key = source.stateKey
    }
    else -> return
  }
  val select: (Int) -> Unit = { index ->
    interact(OverlayInteraction.Select(pager, key, index, source.onTap.orEmpty()))
  }
  if (source is OverlayBottomNavNode)
    NavigationBar(modifier) {
      items.forEachIndexed { index, item ->
        NavigationBarItem(
          node.selection == index,
          { select(index) },
          icon = { OverlayNavigationIcon(item) },
          label = { Text(item.label) },
        )
      }
    }
  else if (source is OverlayTabBarNode && source.scrollable)
    ScrollableTabRow(node.selection, modifier) {
      items.forEachIndexed { index, item ->
        OverlayNavigationTab(item, node.selection == index) { select(index) }
      }
    }
  else
    TabRow(node.selection, modifier) {
      items.forEachIndexed { index, item ->
        OverlayNavigationTab(item, node.selection == index) { select(index) }
      }
    }
}

@Composable
private fun OverlayNavigationTab(item: OverlayItem, selected: Boolean, select: () -> Unit) {
  Tab(
    selected,
    select,
    text = { Text(item.label) },
    icon = {
      if (item.icon != null || item.image != null) OverlayNavigationIcon(item)
    },
  )
}

/** An in-window sheet: no Dialog/extra window, so scrim and gestures stay inside overlay bounds. */
@Composable
private fun RenderOverlaySheet(
  node: OverlayRenderNode,
  modifier: Modifier,
  interact: (OverlayInteraction) -> Unit,
) {
  val source = node.source as? OverlayBottomSheetNode ?: return
  if (!node.sheetOpen) return
  BoxWithConstraints(Modifier.fillMaxSize()) {
    val heights = overlaySheetHeights(source.detents, maxHeight.value.toDouble())
    var height by remember(node.identity, heights) { mutableDoubleStateOf(heights.first()) }
    var drag by remember(node.identity) { mutableDoubleStateOf(0.0) }
    val density = LocalDensity.current.density
    Box(
      Modifier.fillMaxSize()
        .background(source.scrim?.let(::overlayColor) ?: Color(0x66000000))
        .clickable { interact(OverlayInteraction.SheetDismiss(source.openWhen)) },
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
              val settled = settleOverlaySheet(heights, height, drag, source.dismissOnSwipe)
              drag = 0.0
              if (settled == null) interact(OverlayInteraction.SheetDismiss(source.openWhen))
              else height = settled
            },
          )
        }
        // Consume body taps to keep the scrim from closing the sheet through empty content.
        .clickable {
          if (!source.onTap.isNullOrEmpty())
            interact(OverlayInteraction.Tap(source.onTap.orEmpty()))
        },
    ) {
      if (source.dragHandle)
        Box(
          Modifier.align(Alignment.CenterHorizontally)
            .padding(8.dp)
            .size(32.dp, 4.dp)
            .background(Color.Gray, RoundedCornerShape(2.dp)),
        )
      node.children.forEach {
        RenderOverlayNode(it, interact, columnWeight(it), it.weightAxis(OverlayWeightAxis.VERTICAL))
      }
    }
  }
}

@Composable
private fun overlayNodeModifier(
  node: OverlayRenderNode,
  interact: (OverlayInteraction) -> Unit,
  weightAxis: OverlayWeightAxis? = null,
  windowRoot: Boolean = false,
): Modifier {
  val style = node.style.source
  val actions = node.source?.onTap.orEmpty()
  val tappable =
    actions.isNotEmpty() &&
      node.role != "textField" &&
      node.role !in OVERLAY_MODAL_ROLES &&
      node.role !in OVERLAY_COMPONENT_ROLES &&
      node.role !in OVERLAY_SELECTION_ROLES &&
      node.role !in OVERLAY_MATERIAL_ROLES
  val presses = remember { MutableInteractionSource() }
  var modifier: Modifier = Modifier
  // Outermost: the anchor fixes where the whole node, offset and touch target included, lands on
  // screen (#9316). The host resolved element anchors to screen dp bounds before sending.
  val anchor = node.source?.anchor as? OverlayBoundsAnchor
  if (anchor != null) {
    modifier = modifier.overlayAnchor(anchor, currentOverlayWindowGeometry(), windowRoot)
  }
  // A draw-time shift of the whole node (shadow, touch target and semantics included); siblings
  // keep the layout slot it would have had.
  style.offset?.let { modifier = modifier.offset(it.x.toFloat().dp, it.y.toFloat().dp) }
  // Outside the touch target and drawing, so the whole node (shadow included) shrinks as one.
  val pressScale = style.pressScale
  if (tappable && pressScale != null) {
    modifier = modifier.overlayPressScale(presses, pressScale.toFloat())
  }
  // Outermost, as in Material components: reserves a 48 dp touch target around a smaller node
  // without changing the size it draws at (#10435).
  if (tappable) modifier = modifier.minimumInteractiveComponentSize()
  // A cover anchor sizes the node to the anchor bounds: authored sizes would only wrap or clamp it.
  if (anchor == null || !overlayAnchorCovers(anchor))
    modifier = authoredSizeModifier(modifier, style, weightAxis)
  modifier = modifier.alpha((style.alpha ?: 1.0).toFloat())
  val shape =
    overlayCornerShape(MaterialTheme.shapes, style.cornerRadius ?: OverlayCornerRadius.Dp(0.0))
  // Before clip/background/border so the shadow is drawn outside the clipped content.
  style.elevation?.let {
    val shadowColor =
      overlayThemedColor(node.style.shadowColor, style.shadowColor) ?: DefaultShadowColor
    modifier =
      modifier.shadow(it.toFloat().dp, shape, ambientColor = shadowColor, spotColor = shadowColor)
  }
  if (style.cornerRadius != null) modifier = modifier.clip(shape)
  overlayThemedColor(node.style.background, style.background)?.let {
    modifier = modifier.background(it, shape)
  }
  style.gradient?.let { modifier = modifier.background(overlayGradientBrush(it), shape) }
  style.border?.let {
    val borderColor = overlayThemedColor(node.style.borderColor, it.color)
    modifier = modifier.border(it.width.toFloat().dp, checkNotNull(borderColor), shape)
  }
  // Click handling and semantics go before the inset and authored padding, so the whole drawn node
  // is tappable, its ripple covers it, and its accessibility bounds are its drawn bounds (#10435).
  if (tappable) {
    modifier =
      modifier.clickable(interactionSource = presses, indication = LocalIndication.current) {
        interact(OverlayInteraction.Tap(actions))
      }
  }
  val description =
    overlayContentDescription(
      node.role,
      node.text,
      node.iconName,
      tappable,
      node.children,
      node.contentDescription,
    )
  val state =
    overlayStateDescription(node.role, node.page, node.children.size, overlayPickerValue(node))
  // A layout container with nothing of its own to report gets no semantics node, so its children
  // join the nearest reporting ancestor, as with Compose's own layouts (#10446).
  if (!isSemanticsFreeContainer(node, tappable, description, state)) {
    modifier = modifier.semantics {
      if (node.role != "textField" && node.role !in SEMANTICS_FREE_CONTAINERS) {
        text = AnnotatedString(node.text)
      }
      this[OverlayRole] = node.role
      if (node.role == "icon" || node.role == "image") role = Role.Image
      // Compose has no native role for text or layout containers; the kind travels in OverlayRole.
      description?.let { contentDescription = it }
      state?.let { stateDescription = it }
      node.testTag?.let { testTag = it }
    }
  }
  val insetFloor = LocalOverlayInsetFloor.current
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
  setOf("box", "row", "column", "scroll", "pager", "spacer", "card", "divider")

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
  node: OverlayRenderNode,
  tappable: Boolean,
  description: String?,
  state: String?,
): Boolean =
  node.role in SEMANTICS_FREE_CONTAINERS &&
    !tappable &&
    node.text.isEmpty() &&
    node.testTag == null &&
    description == null &&
    state == null

/**
 * The accessible label for an overlay node. An authored `contentDescription` wins, then authored
 * text; an icon-only tappable node reads as its icon name, and so does a tappable layout container
 * whose only content is an icon (a FAB). A layout container or navigation bar is never labelled by
 * its node kind ("box", "row", "tabBar") while it has content (#10524, #10608, #10446): its
 * children label it instead. Only a tappable container with no children at all keeps its kind, as
 * nothing else names it. Every other node keeps its kind as the label.
 */
internal fun overlayContentDescription(
  role: String,
  text: String,
  iconName: String?,
  tappable: Boolean,
  children: List<OverlayRenderNode> = emptyList(),
  authored: String? = null,
): String? =
  when {
    !authored.isNullOrEmpty() -> authored
    text.isNotEmpty() -> text
    (tappable || role in OVERLAY_ICON_CONTROL_ROLES) && !iconName.isNullOrEmpty() -> iconName
    role in CHILD_LABELLED_ROLES -> null
    role !in SEMANTICS_FREE_CONTAINERS -> role
    !tappable -> null
    children.isEmpty() -> role
    else -> overlayIconOnlyLabel(children)
  }

/**
 * The icon name when the only visible content under a container is one named icon, possibly inside
 * plain single-child layout containers; null for any other content.
 */
private fun overlayIconOnlyLabel(children: List<OverlayRenderNode>): String? {
  val only = children.filter { it.visible }.singleOrNull() ?: return null
  return when {
    only.role == "icon" -> only.iconName?.takeIf { it.isNotEmpty() }
    only.role in SEMANTICS_FREE_CONTAINERS &&
      only.text.isEmpty() &&
      only.source?.onTap.isNullOrEmpty() -> overlayIconOnlyLabel(only.children)
    else -> null
  }
}

/**
 * A pager reports its position (`Page 2 of 4`) and a time or date picker its bound [value]
 * (`07:30`, `2026-10-08`); other roles carry no state of their own here.
 */
internal fun overlayStateDescription(
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
internal fun overlayPickerValue(node: OverlayRenderNode): String? =
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
  style: OverlayStyle,
  weightAxis: OverlayWeightAxis?,
): Modifier {
  // Bounds before the authored size: `width`/`height`/`fill` are then coerced into min/max, where
  // the reverse order would clamp the bounds into an already-fixed size instead (#10537).
  var sized = sizeConstraintModifier(modifier, style)
  sized =
    dimensionModifier(
      sized,
      style.width,
      horizontal = true,
      weighted = weightAxis == OverlayWeightAxis.HORIZONTAL,
    )
  sized =
    dimensionModifier(
      sized,
      style.height,
      horizontal = false,
      weighted = weightAxis == OverlayWeightAxis.VERTICAL,
    )
  return style.aspectRatio?.let { sized.aspectRatio(it.toFloat()) } ?: sized
}

private fun dimensionModifier(
  modifier: Modifier,
  size: OverlayDimension?,
  horizontal: Boolean,
  weighted: Boolean = false,
): Modifier =
  when (size) {
    OverlayDimension.Fill -> if (horizontal) modifier.fillMaxWidth() else modifier.fillMaxHeight()
    is OverlayDimension.Dp ->
      if (horizontal) modifier.width(size.dp.toFloat().dp)
      else modifier.height(size.dp.toFloat().dp)
    null -> if (weighted) modifier else wrapContent(modifier, horizontal)
    OverlayDimension.Wrap -> wrapContent(modifier, horizontal)
  }

private fun wrapContent(modifier: Modifier, horizontal: Boolean): Modifier =
  if (horizontal) modifier.wrapContentWidth() else modifier.wrapContentHeight()

/** The main axis a Row/Column child's `weight` fills. */
internal enum class OverlayWeightAxis {
  HORIZONTAL,
  VERTICAL,
}

/** [axis] when this child carries a `weight`, so its own size on that axis does not wrap. */
private fun OverlayRenderNode.weightAxis(axis: OverlayWeightAxis): OverlayWeightAxis? =
  axis.takeIf {
    style.source.weight != null
  }

/** Child `weight` takes the remaining main-axis space; only meaningful inside a Row. */
private fun RowScope.rowWeight(child: OverlayRenderNode): Modifier =
  child.style.source.weight?.let { Modifier.weight(it.toFloat()) } ?: Modifier

/** Child `weight` takes the remaining main-axis space; only meaningful inside a Column. */
private fun ColumnScope.columnWeight(child: OverlayRenderNode): Modifier =
  child.style.source.weight?.let { Modifier.weight(it.toFloat()) } ?: Modifier

/** Applied before width/height so `fill` and `dp` are clamped by the authored min/max. */
private fun sizeConstraintModifier(modifier: Modifier, style: OverlayStyle): Modifier =
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
private fun overlayGradientBrush(gradient: OverlayGradient): Brush =
  object : ShaderBrush() {
    override fun createShader(size: Size): Shader =
      when (gradient) {
        is OverlayLinearGradient -> {
          val (colors, positions) = overlayGradientStops(gradient.stops)
          val (from, to) = overlayLinearGradientLine(gradient.angle, size.width, size.height)
          LinearGradientShader(from, to, colors, positions)
        }
        is OverlayRadialGradient -> {
          val (colors, positions) = overlayGradientStops(gradient.stops)
          RadialGradientShader(
            size.center,
            hypot(size.width, size.height) / 2f,
            colors,
            positions,
          )
        }
      }
  }
