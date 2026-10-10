package dev.jasonpearson.automobile.ctrlproxy.prototype

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
internal val LocalPrototypeTextEpochs = compositionLocalOf<Map<String, Int>> { emptyMap() }

val PrototypeRole = SemanticsPropertyKey<String>("PrototypeRole")

/** Compose owns gesture mechanics only; all authored state/actions go through the pure runtime. */
@Composable
internal fun PrototypeRuntimeContent(
  runtime: PrototypeRuntime,
  images: PrototypeImageCache? = null,
  fonts: PrototypeFontCache? = null,
  interact: suspend (PrototypeInteraction) -> Unit,
) {
  val snapshot by runtime.snapshots.collectAsState()
  val resolver = LocalContext.current.contentResolver
  val durationScale by rememberAnimatorDurationScale(resolver)
  val motion = prototypeMotionEnabled(snapshot.spec.motion, durationScale)
  if (snapshot.active) {
    key(runtime) {
      // One ordered queue drained by one coroutine: interactions reach the controller exactly in
      // the order they happened, whatever the dispatcher does with separately launched jobs.
      val queue = remember { Channel<PrototypeInteraction>(Channel.UNLIMITED) }
      LaunchedEffect(queue) { for (interaction in queue) interact(interaction) }
      CompositionLocalProvider(
        LocalPrototypeTextEpochs provides snapshot.textEpochs,
        LocalPrototypeImageCache provides images,
        LocalPrototypeFontCache provides fonts,
        LocalPrototypeMotion provides motion,
      ) {
        PrototypeSpecContent(
          mapPrototypeSpec(snapshot.spec, snapshot.pages).root,
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
fun PrototypeSpecContent(
  root: PrototypeRenderNode,
  theme: PrototypeSpecTheme? = null,
  interact: (PrototypeInteraction) -> Unit = {},
) {
  PrototypeTheme(root, theme) {
    val anchorLocals = remember { PrototypeAnchorLocals() }
    CompositionLocalProvider(LocalPrototypeAnchorLocals provides anchorLocals) {
      val fillsWindow = LocalPrototypeFillsWindow.current
      Box(Modifier.semantics { testTagsAsResourceId = true }) {
        val modals = modalPrototypeSheets(root)
        // An open dialog is modal: the page behind it leaves the accessibility tree, as it does
        // on iOS and as touches already do. A snackbar or sheet does not block the page.
        val pageBlocked = modals.any { it.role == "dialog" }
        // The page box takes the fill: it is the root's parent and must measure the window.
        Box(
          Modifier.then(if (fillsWindow) Modifier.fillWhenEmpty() else Modifier)
            .then(if (pageBlocked) Modifier.clearAndSetSemantics {} else Modifier),
        ) {
          RenderPrototypeNode(root, interact, windowRoot = true)
          PrototypeAnchorLayer(layeredPrototypeAnchors(root), interact)
        }
        modals.forEach { node ->
          key(node.identity) {
            RenderPrototypeModal(node, interact)
            PrototypeAnchorLayer(layeredPrototypeAnchorsIn(node.children), interact)
          }
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
internal val LocalPrototypeFillsWindow = compositionLocalOf { false }

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
  val modifier = prototypeNodeModifier(node, interact)
  when (node.role) {
    "dialog" ->
      RenderPrototypeDialog(node, modifier, interact) {
        node.children.forEach {
          RenderPrototypeNode(
            it,
            interact,
            columnWeight(it),
            it.weightAxis(PrototypeWeightAxis.VERTICAL),
          )
        }
      }
    "snackbar" -> RenderPrototypeSnackbar(node, modifier, interact)
    else -> RenderPrototypeSheet(node, modifier, interact)
  }
}

@Composable
private fun RenderPrototypeNode(
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
  // Only `visibleWhen` nodes animate; wrapping every node would add a layout to each one.
  if (LocalPrototypeMotion.current && node.source?.visibleWhen != null) {
    // The row/column weight rides on the animated container: it is the Row/Column's direct child.
    AnimatedVisibility(
      visible = node.visible,
      modifier = parentModifier,
      enter = prototypeEnterTransition(node.source.transition),
      exit = prototypeExitTransition(node.source.transition),
    ) {
      ProvideAnchorFade(none = node.source.transition == "none") {
        RenderPrototypeNodeContent(node, interact, weightAxis = weightAxis, windowRoot = windowRoot)
      }
    }
  } else if (node.visible) {
    RenderPrototypeNodeContent(node, interact, parentModifier, weightAxis, windowRoot)
  }
}

@Composable
private fun RenderPrototypeNodeContent(
  node: PrototypeRenderNode,
  interact: (PrototypeInteraction) -> Unit,
  parentModifier: Modifier = Modifier,
  weightAxis: PrototypeWeightAxis? = null,
  windowRoot: Boolean = false,
) {
  val modifier = parentModifier.then(prototypeNodeModifier(node, interact, weightAxis, windowRoot))
  // Containers whose children can appear, disappear or change animate their size with them.
  val containerModifier = modifier.prototypeAnimateSize(LocalPrototypeMotion.current)
  when (node.role) {
    "box" ->
      Box(containerModifier, contentAlignment = node.style.alignment) {
        node.children.forEach { RenderPrototypeNode(it, interact) }
      }
    "row" ->
      Row(
        containerModifier,
        horizontalArrangement = prototypeHorizontalArrangement(node.style.source),
        verticalAlignment = node.style.verticalAlignment,
      ) {
        node.children.forEach {
          RenderPrototypeNode(
            it,
            interact,
            rowWeight(it),
            it.weightAxis(PrototypeWeightAxis.HORIZONTAL),
          )
        }
      }
    "column" ->
      Column(
        containerModifier,
        verticalArrangement = prototypeVerticalArrangement(node.style.source),
        horizontalAlignment = node.style.horizontalAlignment,
      ) {
        node.children.forEach {
          RenderPrototypeNode(
            it,
            interact,
            columnWeight(it),
            it.weightAxis(PrototypeWeightAxis.VERTICAL),
          )
        }
      }
    "text" -> {
      val source = node.style.source
      val role = prototypeTextRole(MaterialTheme.typography, source.textStyle)
      // A styled text node with no colour of its own reads as on-surface text, not black.
      val textColor =
        if (source.color == null && role != null) MaterialTheme.colorScheme.onSurface
        else prototypeThemedColor(node.style.color, source.color) ?: node.style.color
      Text(
        node.text,
        modifier,
        color = textColor,
        // sp, so prototype text follows the system font scale like the app it prototypes (#10436).
        // A `textStyle` role supplies size, weight and family; explicit style fields still win.
        fontSize =
          source.textSize?.toFloat()?.sp ?: if (role == null) 14.sp else TextUnit.Unspecified,
        fontWeight = if (role == null || source.fontWeight != null) node.style.fontWeight else null,
        // Only an authored family overrides; otherwise the text inherits the theme's family through
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
    "icon" -> {
      val icon = prototypeIcon(node.iconName, (node.source as? PrototypeIconNode)?.variant)
      if (icon != null)
        Icon(
          icon,
          contentDescription = null,
          modifier = modifier,
          tint =
            (prototypeThemedColor(node.style.color, node.style.source.color) ?: node.style.color)
              .takeOrElse { LocalContentColor.current },
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
      val scroll = rememberScrollState()
      val source = node.source as? PrototypeScrollNode
      val scrolling =
        if (source?.axis == "horizontal") modifier.horizontalScroll(scroll)
        else modifier.verticalScroll(scroll)
      Box(scrolling) { node.children.forEach { RenderPrototypeNode(it, interact) } }
    }
    "pager" -> RenderPrototypePager(node, modifier, interact)
    "tabBar",
    "bottomNav" -> RenderPrototypeNavigation(node, modifier, interact)
    "bottomSheet",
    "dialog",
    "snackbar" -> Unit // Modal content is hoisted above the whole author tree, within this window.
    "iconButton" -> RenderPrototypeIconButton(node, modifier, interact)
    "fab" -> RenderPrototypeFab(node, modifier, interact)
    "segmentedButton" -> RenderPrototypeSegmentedButton(node, modifier, interact)
    "topAppBar" -> RenderPrototypeTopAppBar(node, modifier, interact)
    "divider" -> RenderPrototypeDivider(node, modifier)
    "badge" -> RenderPrototypeBadge(node, modifier)
    "progress" -> RenderPrototypeProgress(node, modifier)
    "timePicker" -> RenderPrototypeTimePicker(node, modifier, interact)
    "datePicker" -> RenderPrototypeDatePicker(node, modifier, interact)
    "textField" -> RenderPrototypeTextField(node, modifier, interact)
    "switch",
    "checkbox" -> RenderPrototypeToggle(node, modifier, interact)
    "button" -> RenderPrototypeButton(node, modifier, interact)
    "radioGroup" -> RenderPrototypeRadioGroup(node, modifier, interact)
    "listItem" -> RenderPrototypeListItem(node, modifier, interact)
    "slider" -> RenderPrototypeSlider(node, modifier, interact)
    "chip" -> RenderPrototypeChip(node, modifier, interact)
    "card" ->
      RenderPrototypeCard(node, modifier) {
        node.children.forEach {
          RenderPrototypeNode(
            it,
            interact,
            columnWeight(it),
            it.weightAxis(PrototypeWeightAxis.VERTICAL),
          )
        }
      }
    // Spacer keeps its size and authored actions.
    else -> Box(modifier)
  }
}

@Composable
private fun RenderPrototypeTextField(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeTextFieldNode ?: return
  val presses = remember { MutableInteractionSource() }
  val focus = remember { FocusRequester() }
  val actions = source.onTap.orEmpty()
  // The shown value is local state, updated synchronously by the IME's own edits; the controller
  // is told afterwards. Binding it to node.text would show the controller's lagging echo, so fast
  // commitText input could be applied against a stale value.
  val epoch = LocalPrototypeTextEpochs.current[source.stateKey] ?: 0
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
  if (actions.isNotEmpty())
    fieldModifier = fieldModifier.semantics {
      onClick {
        focus.requestFocus()
        interact(PrototypeInteraction.Tap(actions))
        true
      }
    }
  // Material's editable field supplies SetText semantics and the keyboard input connection.
  TextField(
    shown,
    { value ->
      if (sync.edit(value)) {
        shown = value
        interact(PrototypeInteraction.TextChange(source.stateKey, value, sync.epoch))
      }
    },
    modifier = fieldModifier,
    interactionSource = presses,
    placeholder = { Text(source.placeholder.orEmpty()) },
  )
}

@Composable
private fun RenderPrototypePager(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypePagerNode ?: return
  val pager = rememberPagerState(initialPage = node.page) { node.children.size }
  val animate = LocalPrototypeMotion.current
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
  val fill = prototypePageFill(node.style.source)
  val pageModifier =
    Modifier.then(if (fill.width) Modifier.fillMaxWidth() else Modifier)
      .then(if (fill.height) Modifier.fillMaxHeight() else Modifier)
  HorizontalPager(pager, modifier) { page ->
    Box(pageModifier) { RenderPrototypeNode(node.children[page], interact) }
  }
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
  val select: (Int) -> Unit = { index ->
    interact(PrototypeInteraction.Select(pager, key, index, source.onTap.orEmpty()))
  }
  if (source is PrototypeBottomNavNode)
    NavigationBar(modifier) {
      items.forEachIndexed { index, item ->
        NavigationBarItem(
          node.selection == index,
          { select(index) },
          icon = { PrototypeNavigationIcon(item) },
          label = { Text(item.label) },
        )
      }
    }
  else if (source is PrototypeTabBarNode && source.scrollable)
    ScrollableTabRow(node.selection, modifier) {
      items.forEachIndexed { index, item ->
        PrototypeNavigationTab(item, node.selection == index) { select(index) }
      }
    }
  else
    TabRow(node.selection, modifier) {
      items.forEachIndexed { index, item ->
        PrototypeNavigationTab(item, node.selection == index) { select(index) }
      }
    }
}

@Composable
private fun PrototypeNavigationTab(item: PrototypeItem, selected: Boolean, select: () -> Unit) {
  Tab(
    selected,
    select,
    text = { Text(item.label) },
    icon = {
      if (item.icon != null || item.image != null) PrototypeNavigationIcon(item)
    },
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
          source.scrim?.let(::prototypeColor)
            ?: prototypeSheetScrimFallback(MaterialTheme.colorScheme),
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

@Composable
private fun prototypeNodeModifier(
  node: PrototypeRenderNode,
  interact: (PrototypeInteraction) -> Unit,
  weightAxis: PrototypeWeightAxis? = null,
  windowRoot: Boolean = false,
): Modifier {
  val style = node.style.source
  val actions = node.source?.onTap.orEmpty()
  val tappable =
    actions.isNotEmpty() &&
      node.role != "textField" &&
      node.role !in PROTOTYPE_MODAL_ROLES &&
      node.role !in PROTOTYPE_COMPONENT_ROLES &&
      node.role !in PROTOTYPE_SELECTION_ROLES &&
      node.role !in PROTOTYPE_MATERIAL_ROLES
  val presses = remember { MutableInteractionSource() }
  var modifier: Modifier = Modifier
  // Outermost: the anchor fixes where the whole node, offset and touch target included, lands on
  // screen (#9316). The host resolved element anchors to screen dp bounds before sending.
  val anchor = node.source?.anchor as? PrototypeBoundsAnchor
  if (anchor != null) {
    modifier = modifier.prototypeAnchor(anchor, currentPrototypeWindowGeometry(), windowRoot)
  }
  // A draw-time shift of the whole node (shadow, touch target and semantics included); siblings
  // keep the layout slot it would have had.
  style.offset?.let { modifier = modifier.offset(it.x.toFloat().dp, it.y.toFloat().dp) }
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
  modifier = modifier.alpha((style.alpha ?: 1.0).toFloat())
  val shape =
    prototypeCornerShape(MaterialTheme.shapes, style.cornerRadius ?: PrototypeCornerRadius.Dp(0.0))
  // Before clip/background/border so the shadow is drawn outside the clipped content.
  style.elevation?.let {
    val shadowColor =
      prototypeThemedColor(node.style.shadowColor, style.shadowColor) ?: DefaultShadowColor
    modifier =
      modifier.shadow(it.toFloat().dp, shape, ambientColor = shadowColor, spotColor = shadowColor)
  }
  if (style.cornerRadius != null) modifier = modifier.clip(shape)
  prototypeThemedColor(node.style.background, style.background)?.let {
    modifier = modifier.background(it, shape)
  }
  style.gradient?.let { modifier = modifier.background(prototypeGradientBrush(it), shape) }
  style.border?.let {
    val borderColor = prototypeThemedColor(node.style.borderColor, it.color)
    modifier = modifier.border(it.width.toFloat().dp, checkNotNull(borderColor), shape)
  }
  // Click handling and semantics go before the inset and authored padding, so the whole drawn node
  // is tappable, its ripple covers it, and its accessibility bounds are its drawn bounds (#10435).
  if (tappable) {
    modifier =
      modifier.clickable(interactionSource = presses, indication = LocalIndication.current) {
        interact(PrototypeInteraction.Tap(actions))
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
    )
  val state =
    prototypeStateDescription(node.role, node.page, node.children.size, prototypePickerValue(node))
  // A layout container with nothing of its own to report gets no semantics node, so its children
  // join the nearest reporting ancestor, as with Compose's own layouts (#10446).
  if (!isSemanticsFreeContainer(node, tappable, description, state)) {
    modifier = modifier.semantics {
      if (node.role != "textField" && node.role !in SEMANTICS_FREE_CONTAINERS) {
        text = AnnotatedString(node.text)
      }
      this[PrototypeRole] = node.role
      if (node.role == "icon" || node.role == "image") role = Role.Image
      // Compose has no native role for text or layout containers; the kind travels in
      // PrototypeRole.
      description?.let { contentDescription = it }
      state?.let { stateDescription = it }
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
  node: PrototypeRenderNode,
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
 * The accessible label for a prototype node. An authored `contentDescription` wins, then authored
 * text; an icon-only tappable node reads as its icon name, and so does a tappable layout container
 * whose only content is an icon (a FAB). A layout container or navigation bar is never labelled by
 * its node kind ("box", "row", "tabBar") while it has content (#10524, #10608, #10446): its
 * children label it instead. Only a tappable container with no children at all keeps its kind, as
 * nothing else names it. Every other node keeps its kind as the label.
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
    only.role in SEMANTICS_FREE_CONTAINERS &&
      only.text.isEmpty() &&
      only.source?.onTap.isNullOrEmpty() -> prototypeIconOnlyLabel(only.children)
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
private fun prototypeGradientBrush(gradient: PrototypeGradient): Brush =
  object : ShaderBrush() {
    override fun createShader(size: Size): Shader =
      when (gradient) {
        is PrototypeLinearGradient -> {
          val (colors, positions) = prototypeGradientStops(gradient.stops)
          val (from, to) = prototypeLinearGradientLine(gradient.angle, size.width, size.height)
          LinearGradientShader(from, to, colors, positions)
        }
        is PrototypeRadialGradient -> {
          val (colors, positions) = prototypeGradientStops(gradient.stops)
          RadialGradientShader(
            size.center,
            hypot(size.width, size.height) / 2f,
            colors,
            positions,
          )
        }
      }
  }
