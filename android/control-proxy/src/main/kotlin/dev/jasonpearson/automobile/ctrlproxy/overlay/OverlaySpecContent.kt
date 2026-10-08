package dev.jasonpearson.automobile.ctrlproxy.overlay

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandIn
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkOut
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.takeOrElse
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.protocol.*
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
  interact: suspend (OverlayInteraction) -> Unit,
) {
  val snapshot by runtime.snapshots.collectAsState()
  val resolver = LocalContext.current.contentResolver
  val motion =
    remember(snapshot.spec) {
      overlayMotionEnabled(snapshot.spec.motion, readAnimatorDurationScale(resolver))
    }
  if (snapshot.active) {
    key(runtime) {
      // One ordered queue drained by one coroutine: interactions reach the controller exactly in
      // the order they happened, whatever the dispatcher does with separately launched jobs.
      val queue = remember { Channel<OverlayInteraction>(Channel.UNLIMITED) }
      LaunchedEffect(queue) { for (interaction in queue) interact(interaction) }
      CompositionLocalProvider(
        LocalOverlayTextEpochs provides snapshot.textEpochs,
        LocalOverlayImageCache provides images,
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
    Box(Modifier.semantics { testTagsAsResourceId = true }) {
      RenderOverlayNode(root, interact)
      modalOverlaySheets(root).forEach { node ->
        key(node.identity) {
          RenderOverlaySheet(node, overlayNodeModifier(node, interact), interact)
        }
      }
    }
  }
}

@Composable
private fun RenderOverlayNode(
  node: OverlayRenderNode,
  interact: (OverlayInteraction) -> Unit,
  parentModifier: Modifier = Modifier,
) {
  // Only `visibleWhen` nodes animate; wrapping every node would add a layout to each one.
  if (LocalOverlayMotion.current && node.source?.visibleWhen != null) {
    // The row/column weight rides on the animated container: it is the Row/Column's direct child.
    AnimatedVisibility(
      visible = node.visible,
      modifier = parentModifier,
      enter = fadeIn() + expandIn(),
      exit = fadeOut() + shrinkOut(),
    ) {
      RenderOverlayNodeContent(node, interact)
    }
  } else if (node.visible) {
    RenderOverlayNodeContent(node, interact, parentModifier)
  }
}

@Composable
private fun RenderOverlayNodeContent(
  node: OverlayRenderNode,
  interact: (OverlayInteraction) -> Unit,
  parentModifier: Modifier = Modifier,
) {
  val modifier = parentModifier.then(overlayNodeModifier(node, interact))
  when (node.role) {
    "box" ->
      Box(modifier, contentAlignment = node.style.alignment) {
        node.children.forEach { RenderOverlayNode(it, interact) }
      }
    "row" ->
      Row(
        modifier,
        horizontalArrangement = overlayHorizontalArrangement(node.style.source),
        verticalAlignment = node.style.verticalAlignment,
      ) {
        node.children.forEach { RenderOverlayNode(it, interact, rowWeight(it)) }
      }
    "column" ->
      Column(
        modifier,
        verticalArrangement = overlayVerticalArrangement(node.style.source),
        horizontalAlignment = node.style.horizontalAlignment,
      ) {
        node.children.forEach { RenderOverlayNode(it, interact, columnWeight(it)) }
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
        fontFamily = if (role == null || source.fontFamily != null) node.style.fontFamily else null,
        textAlign = node.style.textAlign,
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
                ?: Color.LightGray
            )
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
    "bottomSheet" ->
      Unit // Modal content is hoisted above the whole author tree, within this window.
    "textField" -> RenderOverlayTextField(node, modifier, interact)
    "switch",
    "checkbox" -> RenderOverlayToggle(node, modifier, interact)
    "button" -> RenderOverlayButton(node, modifier, interact)
    "slider" -> RenderOverlaySlider(node, modifier, interact)
    "chip" -> RenderOverlayChip(node, modifier, interact)
    "card" ->
      RenderOverlayCard(node, modifier) {
        node.children.forEach { RenderOverlayNode(it, interact, columnWeight(it)) }
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
  LaunchedEffect(node.page) {
    if (pager.currentPage != node.page) {
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
        .clickable { interact(OverlayInteraction.SheetDismiss(source.openWhen)) }
    )
    Column(
      modifier
        .align(Alignment.BottomCenter)
        .fillMaxWidth()
        .height((height - drag).coerceIn(0.0, maxHeight.value.toDouble()).toFloat().dp)
        .background(
          overlayThemedColor(node.style.background, node.style.source.background)
            ?: MaterialTheme.colorScheme.surface
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
        }
    ) {
      if (source.dragHandle)
        Box(
          Modifier.align(Alignment.CenterHorizontally)
            .padding(8.dp)
            .size(32.dp, 4.dp)
            .background(Color.Gray, RoundedCornerShape(2.dp))
        )
      node.children.forEach { RenderOverlayNode(it, interact, columnWeight(it)) }
    }
  }
}

@Composable
private fun overlayNodeModifier(
  node: OverlayRenderNode,
  interact: (OverlayInteraction) -> Unit,
): Modifier {
  val style = node.style.source
  val actions = node.source?.onTap.orEmpty()
  val tappable =
    actions.isNotEmpty() &&
      node.role != "textField" &&
      node.role != "bottomSheet" &&
      node.role !in OVERLAY_COMPONENT_ROLES
  var modifier: Modifier = Modifier
  // Outermost, as in Material components: reserves a 48 dp touch target around a smaller node
  // without changing the size it draws at (#10435).
  if (tappable) modifier = modifier.minimumInteractiveComponentSize()
  modifier = dimensionModifier(modifier, style.width, horizontal = true)
  modifier = dimensionModifier(modifier, style.height, horizontal = false)
  modifier = modifier.alpha((style.alpha ?: 1.0).toFloat())
  modifier = sizeConstraintModifier(modifier, style)
  val shape =
    overlayCornerShape(MaterialTheme.shapes, style.cornerRadius ?: OverlayCornerRadius.Dp(0.0))
  if (style.cornerRadius != null) modifier = modifier.clip(shape)
  overlayThemedColor(node.style.background, style.background)?.let {
    modifier = modifier.background(it, shape)
  }
  style.border?.let {
    val borderColor = overlayThemedColor(node.style.borderColor, it.color)
    modifier = modifier.border(it.width.toFloat().dp, checkNotNull(borderColor), shape)
  }
  // Click handling and semantics go before the inset and authored padding, so the whole drawn node
  // is tappable, its ripple covers it, and its accessibility bounds are its drawn bounds (#10435).
  if (tappable) modifier = modifier.clickable { interact(OverlayInteraction.Tap(actions)) }
  modifier = modifier.semantics {
    if (node.role != "textField") text = AnnotatedString(node.text)
    this[OverlayRole] = node.role
    if (node.role == "icon" || node.role == "image") role = Role.Image
    // Compose has no native role for text or layout containers; the kind travels in OverlayRole.
    overlayContentDescription(node.role, node.text, node.iconName, tappable)?.let {
      contentDescription = it
    }
    overlayStateDescription(node.role, node.page, node.children.size)?.let {
      stateDescription = it
    }
    node.testTag?.let { testTag = it }
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
          }
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
  setOf("box", "row", "column", "scroll", "pager", "spacer", "card")

/**
 * The accessible label for an overlay node. Authored text wins; an icon-only tappable node reads as
 * its icon name. Layout containers with neither text nor actions get none, so they stay out of the
 * skeleton instead of being labelled by their node kind ("box", "row"). Every other node keeps its
 * kind as the label.
 */
internal fun overlayContentDescription(
  role: String,
  text: String,
  iconName: String?,
  tappable: Boolean,
): String? =
  when {
    text.isNotEmpty() -> text
    tappable && !iconName.isNullOrEmpty() -> iconName
    !tappable && role in SEMANTICS_FREE_CONTAINERS -> null
    else -> role
  }

/** A pager reports its position (`Page 2 of 4`); other roles carry no state of their own here. */
internal fun overlayStateDescription(role: String, page: Int, pageCount: Int): String? =
  if (role == "pager" && pageCount > 0) "Page ${page + 1} of $pageCount" else null

private fun dimensionModifier(
  modifier: Modifier,
  size: OverlayDimension?,
  horizontal: Boolean,
): Modifier =
  when (size) {
    OverlayDimension.Fill -> if (horizontal) modifier.fillMaxWidth() else modifier.fillMaxHeight()
    is OverlayDimension.Dp ->
      if (horizontal) modifier.width(size.dp.toFloat().dp)
      else modifier.height(size.dp.toFloat().dp)
    OverlayDimension.Wrap,
    null -> if (horizontal) modifier.wrapContentWidth() else modifier.wrapContentHeight()
  }

/** Child `weight` takes the remaining main-axis space; only meaningful inside a Row. */
private fun RowScope.rowWeight(child: OverlayRenderNode): Modifier =
  child.style.source.weight?.let { Modifier.weight(it.toFloat()) } ?: Modifier

/** Child `weight` takes the remaining main-axis space; only meaningful inside a Column. */
private fun ColumnScope.columnWeight(child: OverlayRenderNode): Modifier =
  child.style.source.weight?.let { Modifier.weight(it.toFloat()) } ?: Modifier

/** Applied after width/height so `fill` and `dp` are clamped by the authored min/max. */
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
