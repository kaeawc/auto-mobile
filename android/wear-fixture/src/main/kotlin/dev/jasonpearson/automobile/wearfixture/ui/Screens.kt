package dev.jasonpearson.automobile.wearfixture.ui

import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.BasicSwipeToDismissBox
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material3.AlertDialog
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.EdgeButton
import androidx.wear.compose.material3.FilledTonalButton
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import dev.jasonpearson.automobile.wearfixture.RotaryPickerModel
import dev.jasonpearson.automobile.wearfixture.WearFixtureCatalog

@Composable
internal fun HomeScreen(status: String, onAction: (String) -> Unit, onItem: (String) -> Unit) {
  val listState = rememberScalingLazyListState()
  ScreenScaffold(scrollState = listState) { contentPadding ->
    ScalingLazyColumn(
      state = listState,
      contentPadding = contentPadding,
      modifier = Modifier.fillMaxSize().testTag("fixture_list"),
    ) {
      item { ListHeader { Text(WearFixtureCatalog.APP_TITLE) } }
      item {
        Text(
          status,
          textAlign = TextAlign.Center,
          modifier = Modifier.fillMaxWidth().testTag("fixture_status"),
        )
      }
      items(WearFixtureCatalog.actions, key = { it.id }) { action ->
        FilledTonalButton(
          onClick = { onAction(action.id) },
          modifier = Modifier.fillMaxWidth().testTag(action.id),
          label = { Text(action.label) },
        )
      }
      items(WearFixtureCatalog.items, key = { it.id }) { item ->
        Button(
          onClick = { onItem(item.id) },
          modifier = Modifier.fillMaxWidth().testTag(item.id),
          label = { Text(item.title) },
        )
      }
    }
  }
}

@Composable
internal fun DetailScreen(itemId: String, onDismissed: () -> Unit) {
  val item = WearFixtureCatalog.item(itemId) ?: return
  SwipeToDismiss(onDismissed) {
    CenteredColumn(Modifier.testTag("detail_screen")) {
      Text(item.title, modifier = Modifier.testTag("detail_title"))
      Text(item.detail, textAlign = TextAlign.Center, modifier = Modifier.testTag("detail_text"))
    }
  }
}

/** Moves only with rotary input: there is no touch, drag or click handler on this screen. */
@Composable
internal fun PickerScreen(index: Int, onIndexChange: (Int) -> Unit, onDismissed: () -> Unit) {
  var model by remember {
    mutableStateOf(
      RotaryPickerModel(valueCount = WearFixtureCatalog.pickerValues.size, index = index),
    )
  }
  val focusRequester = remember { FocusRequester() }
  SwipeToDismiss(onDismissed) {
    CenteredColumn(
      Modifier.onRotaryScrollEvent { event ->
          val next = model.onRotary(event.verticalScrollPixels)
          if (next.index != model.index) onIndexChange(next.index)
          model = next
          true
        }
        .focusRequester(focusRequester)
        .focusable()
        .testTag("picker"),
    ) {
      Text(WearFixtureCatalog.PICKER_HINT)
      Text(
        WearFixtureCatalog.pickerValues[model.index],
        style = MaterialTheme.typography.displayMedium,
        modifier = Modifier.testTag("picker_value"),
      )
    }
  }
  LaunchedEffect(Unit) { focusRequester.requestFocus() }
}

@Composable
internal fun DismissScreen(onDismissed: () -> Unit) {
  SwipeToDismiss(onDismissed) {
    CenteredColumn(Modifier.testTag("dismiss_screen")) {
      Text(WearFixtureCatalog.DISMISS_TEXT, textAlign = TextAlign.Center)
    }
  }
}

@Composable
internal fun ConfirmDialog(visible: Boolean, onResult: (Boolean) -> Unit) {
  AlertDialog(
    visible = visible,
    onDismissRequest = { onResult(false) },
    title = { Text(WearFixtureCatalog.CONFIRM_TITLE, textAlign = TextAlign.Center) },
    edgeButton = {
      EdgeButton(onClick = { onResult(true) }, modifier = Modifier.testTag("confirm_button")) {
        Text(WearFixtureCatalog.CONFIRM_LABEL)
      }
    },
  ) {
    item {
      FilledTonalButton(
        onClick = { onResult(false) },
        modifier = Modifier.fillMaxWidth().testTag("cancel_button"),
        label = { Text(WearFixtureCatalog.CANCEL_LABEL) },
      )
    }
  }
}

/**
 * Swiping right pops this screen. The box consumes the gesture, so the window-level swipe that
 * would close the whole activity only applies on the home screen.
 */
@Composable
private fun SwipeToDismiss(onDismissed: () -> Unit, content: @Composable () -> Unit) {
  BasicSwipeToDismissBox(onDismissed = onDismissed) { isBackground ->
    if (!isBackground) {
      ScreenScaffold { content() }
    }
  }
}

@Composable
private fun CenteredColumn(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
  Box(modifier.fillMaxSize().padding(horizontal = 16.dp), contentAlignment = Alignment.Center) {
    Column(
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      content()
    }
  }
}
