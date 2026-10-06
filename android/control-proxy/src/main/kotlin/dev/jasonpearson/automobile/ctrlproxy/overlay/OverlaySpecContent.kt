package dev.jasonpearson.automobile.ctrlproxy.overlay

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
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
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
  interact: suspend (OverlayInteraction) -> Unit,
) {
  val snapshot by runtime.snapshots.collectAsState()
  if (snapshot.active) {
    key(runtime) {
      // One ordered queue drained by one coroutine: interactions reach the controller exactly in
      // the order they happened, whatever the dispatcher does with separately launched jobs.
      val queue = remember { Channel<OverlayInteraction>(Channel.UNLIMITED) }
      LaunchedEffect(queue) { for (interaction in queue) interact(interaction) }
      CompositionLocalProvider(LocalOverlayTextEpochs provides snapshot.textEpochs) {
        OverlaySpecContent(mapOverlaySpec(snapshot.spec, snapshot.pages).root) { interaction ->
          queue.trySend(interaction)
        }
      }
    }
  }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun OverlaySpecContent(root: OverlayRenderNode, interact: (OverlayInteraction) -> Unit = {}) {
  Box(Modifier.semantics { testTagsAsResourceId = true }) {
    RenderOverlayNode(root, interact)
    modalOverlaySheets(root).forEach { node ->
      key(node.identity) { RenderOverlaySheet(node, overlayNodeModifier(node, interact), interact) }
    }
  }
}

@Composable
private fun RenderOverlayNode(node: OverlayRenderNode, interact: (OverlayInteraction) -> Unit) {
  if (!node.visible) return
  val modifier = overlayNodeModifier(node, interact)
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
        node.children.forEach { RenderOverlayNode(it, interact) }
      }
    "column" ->
      Column(
        modifier,
        verticalArrangement = overlayVerticalArrangement(node.style.source),
        horizontalAlignment = node.style.horizontalAlignment,
      ) {
        node.children.forEach { RenderOverlayNode(it, interact) }
      }
    "text" ->
      Text(
        node.text,
        modifier,
        color = node.style.color,
        fontSize =
          with(LocalDensity.current) { (node.style.source.textSize ?: 14.0).toFloat().dp.toSp() },
        fontWeight = node.style.fontWeight,
        fontFamily = node.style.fontFamily,
        textAlign = node.style.textAlign,
        maxLines = node.style.source.maxLines ?: Int.MAX_VALUE,
      )
    "icon" -> {
      val icon = overlayIcon(node.iconName)
      if (icon != null)
        Icon(icon, contentDescription = null, modifier = modifier, tint = node.style.color)
      else
        Box(
          modifier.defaultMinSize(24.dp, 24.dp).background(node.style.background ?: Color.LightGray)
        )
    }
    "image" ->
      Box(
        modifier.defaultMinSize(24.dp, 24.dp).background(node.style.background ?: Color.LightGray)
      )
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
  LaunchedEffect(node.page) { if (pager.currentPage != node.page) pager.scrollToPage(node.page) }
  LaunchedEffect(pager) {
    snapshotFlow { pager.isScrollInProgress to pager.settledPage }
      .distinctUntilChanged()
      .collect { (scrolling, page) ->
        interact(OverlayInteraction.PagerMotion(source.id, page, scrolling))
      }
  }
  HorizontalPager(pager, modifier) { page ->
    Box(Modifier.fillMaxSize()) { RenderOverlayNode(node.children[page], interact) }
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

@Composable
private fun OverlayNavigationIcon(item: OverlayItem) {
  // Image resolution belongs to #9301. Missing images fall back to the built-in icon, then a shape.
  val icon = overlayIcon(item.icon)
  if (icon != null) Icon(icon, contentDescription = null)
  else Box(Modifier.size(24.dp).background(Color.LightGray).semantics { role = Role.Image })
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
        .background(node.style.background ?: Color.White)
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
      node.children.forEach { RenderOverlayNode(it, interact) }
    }
  }
}

@Composable
private fun overlayNodeModifier(
  node: OverlayRenderNode,
  interact: (OverlayInteraction) -> Unit,
): Modifier {
  val style = node.style.source
  var modifier: Modifier = Modifier
  modifier = dimensionModifier(modifier, style.width, horizontal = true)
  modifier = dimensionModifier(modifier, style.height, horizontal = false)
  modifier = modifier.alpha((style.alpha ?: 1.0).toFloat())
  val shape = RoundedCornerShape((style.cornerRadius ?: 0.0).toFloat().dp)
  if (style.cornerRadius != null) modifier = modifier.clip(shape)
  node.style.background?.let { modifier = modifier.background(it, shape) }
  style.border?.let {
    modifier = modifier.border(it.width.toFloat().dp, checkNotNull(node.style.borderColor), shape)
  }
  node.safeArea?.let { safeArea ->
    var insets: WindowInsets = WindowInsets(0, 0, 0, 0)
    for (type in safeArea.types) {
      insets =
        insets.union(
          when (type) {
            "systemBars" -> WindowInsets.systemBars
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
  val actions = node.source?.onTap.orEmpty()
  if (actions.isNotEmpty() && node.role != "textField" && node.role != "bottomSheet")
    modifier = modifier.clickable { interact(OverlayInteraction.Tap(actions)) }
  return modifier.semantics {
    if (node.role != "textField") text = AnnotatedString(node.text)
    this[OverlayRole] = node.role
    if (node.role == "icon" || node.role == "image") role = Role.Image
    // Compose has no native role for text or layout containers. Preserve the node kind as a label
    // for empty primitives as well as a custom semantic role; no button role implies tap support.
    contentDescription = node.text.ifEmpty { node.role }
    node.testTag?.let { testTag = it }
  }
}

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
