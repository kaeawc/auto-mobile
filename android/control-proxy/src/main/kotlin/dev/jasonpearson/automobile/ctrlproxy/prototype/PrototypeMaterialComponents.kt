package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.AlertDialogDefaults
import androidx.compose.material3.Badge
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeFloatingActionButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MediumTopAppBar
import androidx.compose.material3.OutlinedIconButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.VerticalDivider
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeAppBarAction
import dev.jasonpearson.automobile.protocol.PrototypeDatePickerNode
import dev.jasonpearson.automobile.protocol.PrototypeDialogButton
import dev.jasonpearson.automobile.protocol.PrototypeDialogNode
import dev.jasonpearson.automobile.protocol.PrototypeDividerNode
import dev.jasonpearson.automobile.protocol.PrototypeFabNode
import dev.jasonpearson.automobile.protocol.PrototypeIconButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeProgressNode
import dev.jasonpearson.automobile.protocol.PrototypeSegmentedButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeSnackbarNode
import dev.jasonpearson.automobile.protocol.PrototypeTimePickerNode
import dev.jasonpearson.automobile.protocol.PrototypeTopAppBarNode
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged

/**
 * Material 3 controls added by the last slice of #10439 that run their own taps or changes, so
 * [prototypeNodeModifier] must not add a second click handler for these roles.
 */
internal val PROTOTYPE_MATERIAL_ROLES =
  setOf("iconButton", "fab", "segmentedButton", "timePicker", "datePicker")

/** Controls whose only content is an icon, so the icon name labels them when nothing else does. */
internal val PROTOTYPE_ICON_CONTROL_ROLES = setOf("iconButton", "fab")

/** The `testTag` of a part of a composite node: the node's tag, a dot, then the part's name. */
internal fun prototypePartTag(nodeTag: String?, part: String): String? = nodeTag?.let {
  "$it.$part"
}

/** An icon-only Material button: standard (default), filled, tonal or outlined. */
@Composable
internal fun RenderPrototypeIconButton(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeIconButtonNode ?: return
  val actions = source.onTap.orEmpty()
  val onClick = { if (actions.isNotEmpty()) interact(PrototypeInteraction.Tap(actions)) }
  val content: @Composable () -> Unit = {
    prototypeIcon(source.icon)?.let { Icon(it, contentDescription = null) }
  }
  when (source.variant) {
    "filled" -> FilledIconButton(onClick, modifier, content = content)
    "tonal" -> FilledTonalIconButton(onClick, modifier, content = content)
    "outlined" -> OutlinedIconButton(onClick, modifier, content = content)
    else -> IconButton(onClick, modifier, content = content)
  }
}

/** A floating action button; with a `label` it is an extended FAB showing the icon and label. */
@Composable
internal fun RenderPrototypeFab(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeFabNode ?: return
  val actions = source.onTap.orEmpty()
  val onClick = { if (actions.isNotEmpty()) interact(PrototypeInteraction.Tap(actions)) }
  val icon: @Composable () -> Unit = {
    prototypeIcon(source.icon)?.let { Icon(it, contentDescription = null) }
  }
  if (source.label != null) {
    ExtendedFloatingActionButton(
      text = { Text(source.label.orEmpty(), Modifier.clearAndSetSemantics {}) },
      icon = icon,
      onClick = onClick,
      modifier = modifier,
    )
    return
  }
  when (source.size) {
    "small" -> SmallFloatingActionButton(onClick, modifier, content = icon)
    "large" -> LargeFloatingActionButton(onClick, modifier, content = icon)
    else -> FloatingActionButton(onClick, modifier, content = icon)
  }
}

/**
 * A single-select segmented button bound to a string key. Each segment is its own selectable node
 * carrying its label and selected state, tagged `<testTag>.<value>` like a radio option; a tap
 * binds the key to that segment's value, emits `change` when it moved, then runs `onTap`.
 */
@Composable
internal fun RenderPrototypeSegmentedButton(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeSegmentedButtonNode ?: return
  val actions = source.onTap.orEmpty()
  SingleChoiceSegmentedButtonRow(modifier) {
    source.options.forEachIndexed { index, option ->
      SegmentedButton(
        selected = option.value == node.selectedValue,
        onClick = { interact(PrototypeInteraction.Choose(source.stateKey, option.value, actions)) },
        shape = SegmentedButtonDefaults.itemShape(index, source.options.size),
        modifier =
          Modifier.semantics {
            contentDescription = option.label
            prototypeRadioOptionTag(node.testTag, option.value)?.let { testTag = it }
          },
        label = { Text(option.label, Modifier.clearAndSetSemantics {}) },
      )
    }
  }
}

/**
 * A Material top app bar: small (default), centerAligned, medium or large. The title is the node's
 * text; the navigation icon and each action are icon buttons labelled by their `label` and tagged
 * `<testTag>.navigation` and `<testTag>.actions.<index>`. Insets come only from `safeAreaPadding`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RenderPrototypeTopAppBar(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeTopAppBarNode ?: return
  val title: @Composable () -> Unit = { Text(node.text, Modifier.clearAndSetSemantics {}) }
  val navigation: @Composable () -> Unit = {
    source.navigationIcon?.let {
      PrototypeAppBarButton(it, prototypePartTag(node.testTag, "navigation"), interact)
    }
  }
  val actions: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit = {
    source.actions.orEmpty().forEachIndexed { index, action ->
      PrototypeAppBarButton(action, prototypePartTag(node.testTag, "actions.$index"), interact)
    }
  }
  val authoredFill = node.style.source.background != null || node.style.source.gradient != null
  val colors =
    if (authoredFill)
      TopAppBarDefaults.topAppBarColors(
        containerColor = Color.Transparent,
        scrolledContainerColor = Color.Transparent,
      )
    else TopAppBarDefaults.topAppBarColors()
  val insets = WindowInsets(0, 0, 0, 0)
  when (source.variant) {
    "centerAligned" ->
      CenterAlignedTopAppBar(
        title,
        modifier,
        navigation,
        actions,
        windowInsets = insets,
        colors = colors,
      )
    "medium" ->
      MediumTopAppBar(title, modifier, navigation, actions, windowInsets = insets, colors = colors)
    "large" ->
      LargeTopAppBar(title, modifier, navigation, actions, windowInsets = insets, colors = colors)
    else -> TopAppBar(title, modifier, navigation, actions, windowInsets = insets, colors = colors)
  }
}

@Composable
private fun PrototypeAppBarButton(
  action: PrototypeAppBarAction,
  tag: String?,
  interact: (PrototypeInteraction) -> Unit,
) {
  val actions = action.onTap.orEmpty()
  IconButton(
    { if (actions.isNotEmpty()) interact(PrototypeInteraction.Tap(actions)) },
    Modifier.semantics {
      contentDescription = action.label
      tag?.let { testTag = it }
    },
  ) {
    prototypeIcon(action.icon)?.let { Icon(it, contentDescription = null) }
  }
}

/** A Material divider, horizontal (default) or vertical; an authored `style.color` tints it. */
@Composable
internal fun RenderPrototypeDivider(node: PrototypeRenderNode, modifier: Modifier) {
  val source = node.source as? PrototypeDividerNode ?: return
  val color =
    prototypeThemedColor(node.style.color, node.style.source.color)
      ?: MaterialTheme.colorScheme.outlineVariant
  if (source.orientation == "vertical") VerticalDivider(modifier, color = color)
  else HorizontalDivider(modifier, color = color)
}

/** A Material badge: a small dot without `text`, else the text (typically a count). */
@Composable
internal fun RenderPrototypeBadge(node: PrototypeRenderNode, modifier: Modifier) {
  if (node.text.isEmpty()) Badge(modifier)
  else Badge(modifier) { Text(node.text, Modifier.clearAndSetSemantics {}) }
}

/**
 * A Material progress indicator. Bound to a number it is determinate, drawing `value / max`, and
 * Material reports that fraction as progress range info; unbound it is indeterminate.
 */
@Composable
internal fun RenderPrototypeProgress(node: PrototypeRenderNode, modifier: Modifier) {
  val source = node.source as? PrototypeProgressNode ?: return
  val fraction = prototypeProgressFraction(node.sliderValue, source.max)
  val circular = source.variant == "circular"
  when {
    source.stateKey == null && circular -> CircularProgressIndicator(modifier)
    source.stateKey == null -> LinearProgressIndicator(modifier)
    circular -> CircularProgressIndicator({ fraction }, modifier)
    else -> LinearProgressIndicator({ fraction }, modifier)
  }
}

/** The drawn fraction of a determinate progress: the bound value over `max` (default 1). */
internal fun prototypeProgressFraction(value: Double, max: Double?): Float =
  (value / (max ?: 1.0)).coerceIn(0.0, 1.0).toFloat()

/**
 * An open dialog, drawn in-window above the author tree like a sheet: a scrim whose tap closes it,
 * and a Material alert-dialog surface with an optional icon, the title (the node's text), body
 * text, optional custom [content], then the dismiss and confirm buttons. A button closes the dialog
 * (writing the opposite of `openWhen.equals`), then runs its own `onTap`. The buttons are tagged
 * `<testTag>.confirm` and `<testTag>.dismiss`.
 */
@Composable
internal fun RenderPrototypeDialog(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
  content: @Composable ColumnScope.() -> Unit,
) {
  val source = node.source as? PrototypeDialogNode ?: return
  if (!node.sheetOpen) return
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Box(
      Modifier.fillMaxSize()
        .background(prototypeDialogScrimFallback(MaterialTheme.colorScheme))
        .clickable {
          interact(PrototypeInteraction.SheetDismiss(source.openWhen))
        },
    )
    Surface(
      modifier
        .padding(horizontal = 24.dp)
        .widthIn(min = 280.dp, max = 560.dp)
        // Consume body taps so they never reach the scrim; the node's own onTap runs instead.
        .clickable(remember { MutableInteractionSource() }, indication = null) {
          if (!source.onTap.isNullOrEmpty())
            interact(PrototypeInteraction.Tap(source.onTap.orEmpty()))
        },
      shape = AlertDialogDefaults.shape,
      color = AlertDialogDefaults.containerColor,
      tonalElevation = AlertDialogDefaults.TonalElevation,
    ) {
      Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        prototypeIcon(source.icon)?.let {
          Icon(
            it,
            contentDescription = null,
            Modifier.align(Alignment.CenterHorizontally),
            tint = AlertDialogDefaults.iconContentColor,
          )
        }
        if (node.text.isNotEmpty())
          Text(
            node.text,
            Modifier.clearAndSetSemantics {},
            color = AlertDialogDefaults.titleContentColor,
            style = MaterialTheme.typography.headlineSmall,
          )
        node.supportingText?.let {
          Text(
            it,
            color = AlertDialogDefaults.textContentColor,
            style = MaterialTheme.typography.bodyMedium,
          )
        }
        content()
        Row(
          Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
        ) {
          source.dismiss?.let {
            PrototypeDialogTextButton(it, prototypePartTag(node.testTag, "dismiss")) {
              interact(PrototypeInteraction.CloseModal(source.openWhen, it.onTap.orEmpty()))
            }
          }
          PrototypeDialogTextButton(source.confirm, prototypePartTag(node.testTag, "confirm")) {
            interact(
              PrototypeInteraction.CloseModal(source.openWhen, source.confirm.onTap.orEmpty()),
            )
          }
        }
      }
    }
  }
}

/**
 * An open snackbar at the bottom of the window. It is not modal: touches outside it reach the
 * author tree. Its optional action button, tagged `<testTag>.action`, closes it and runs `onTap`.
 */
@Composable
internal fun RenderPrototypeSnackbar(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeSnackbarNode ?: return
  if (!node.sheetOpen) return
  // Leaving composition (the snackbar closed by any route) cancels the pending timeout.
  LaunchedEffect(source.openWhen, source.durationMs) {
    awaitSnackbarTimeout(source.durationMs) {
      interact(PrototypeInteraction.CloseModal(source.openWhen))
    }
  }
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
    Snackbar(
      modifier.padding(12.dp),
      action =
        source.action?.let { action ->
          {
            PrototypeDialogTextButton(action, prototypePartTag(node.testTag, "action")) {
              interact(PrototypeInteraction.CloseModal(source.openWhen, action.onTap.orEmpty()))
            }
          }
        },
    ) {
      Text(node.text, Modifier.clearAndSetSemantics {})
    }
  }
}

/**
 * Waits [durationMs] with [pause], then runs [close]; without a duration it returns at once and the
 * snackbar stays. It is a plain timer: the animator duration scale does not stretch or skip it.
 * [pause] is injectable so tests drive it without real time.
 */
internal suspend fun awaitSnackbarTimeout(
  durationMs: Int?,
  pause: suspend (Long) -> Unit = { delay(it) },
  close: () -> Unit,
) {
  if (durationMs == null) return
  pause(durationMs.toLong())
  close()
}

@Composable
private fun PrototypeDialogTextButton(
  button: PrototypeDialogButton,
  tag: String?,
  onClick: () -> Unit,
) {
  TextButton(onClick, Modifier.semantics { tag?.let { testTag = it } }) { Text(button.label) }
}

/**
 * A Material time picker bound to integer hour and minute keys. The picker's own dial and inputs
 * edit a local state; each settled change sends both keys at once ([PrototypeInteraction.SetTime]),
 * and a new bound value (a re-show or a `setState`) moves the picker.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RenderPrototypeTimePicker(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeTimePickerNode ?: return
  val is24Hour =
    source.is24Hour ?: android.text.format.DateFormat.is24HourFormat(LocalContext.current)
  val state = rememberTimePickerState(node.hour, node.minute, is24Hour)
  val bound by rememberUpdatedState(node.hour to node.minute)
  LaunchedEffect(node.hour, node.minute) {
    if (state.hour != node.hour) state.hour = node.hour
    if (state.minute != node.minute) state.minute = node.minute
  }
  LaunchedEffect(state) {
    snapshotFlow { state.hour to state.minute }
      .distinctUntilChanged()
      .collect { (hour, minute) ->
        if (hour to minute != bound)
          interact(
            PrototypeInteraction.SetTime(
              source.hourKey,
              source.minuteKey,
              hour,
              minute,
              source.onTap.orEmpty(),
            ),
          )
      }
  }
  TimePicker(state, modifier)
}

/**
 * A Material date picker bound to a `YYYY-MM-DD` string key. Picking a day binds the key to that
 * date ([PrototypeInteraction.Choose]); a new bound value moves the selection.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RenderPrototypeDatePicker(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeDatePickerNode ?: return
  val millis = prototypeDateMillis(node.selectedValue)
  val state = rememberDatePickerState(initialSelectedDateMillis = millis)
  val bound by rememberUpdatedState(node.selectedValue)
  LaunchedEffect(millis) {
    if (state.selectedDateMillis != millis) {
      state.selectedDateMillis = millis
      millis?.let { state.displayedMonthMillis = it }
    }
  }
  LaunchedEffect(state) {
    snapshotFlow { state.selectedDateMillis }
      .distinctUntilChanged()
      .collect { selected ->
        val date = selected?.let(::prototypeDateString)
        if (date != null && date != bound)
          interact(PrototypeInteraction.Choose(source.stateKey, date, source.onTap.orEmpty()))
      }
  }
  DatePicker(state, modifier, showModeToggle = false)
}

private val UTC: TimeZone = TimeZone.getTimeZone("UTC")

/** UTC midnight of a validated `YYYY-MM-DD` date, as the Material date picker stores it. */
internal fun prototypeDateMillis(date: String?): Long? {
  val parts = date?.split("-")?.map { it.toIntOrNull() ?: return null } ?: return null
  if (parts.size != 3) return null
  val (year, month, day) = parts
  return Calendar.getInstance(UTC)
    .apply {
      clear()
      set(year, month - 1, day)
    }
    .timeInMillis
}

/** The `YYYY-MM-DD` date of a UTC-midnight picker selection. */
internal fun prototypeDateString(millis: Long): String {
  val calendar = Calendar.getInstance(UTC).apply { timeInMillis = millis }
  return String.format(
    Locale.ROOT,
    "%04d-%02d-%02d",
    calendar.get(Calendar.YEAR),
    calendar.get(Calendar.MONTH) + 1,
    calendar.get(Calendar.DAY_OF_MONTH),
  )
}
