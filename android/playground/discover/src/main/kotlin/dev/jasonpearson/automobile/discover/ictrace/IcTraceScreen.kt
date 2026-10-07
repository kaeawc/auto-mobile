package dev.jasonpearson.automobile.discover.ictrace

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentButton
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentCard
import dev.jasonpearson.automobile.design.system.components.AutoMobileTextField
import dev.jasonpearson.automobile.sdk.TrackRecomposition

internal fun exportIcTrace(recorder: IcTraceRecorder, share: (String) -> Unit) {
  val jsonl = IcTraceFormatter.format(recorder.snapshot())
  share(jsonl)
}

class IcTraceViewModel(val recorder: IcTraceRecorder = IcTraceRecorder()) : ViewModel()

@Composable
fun IcTraceScreen() {
  TrackRecomposition(id = "screen.icTrace", composableName = "IcTraceScreen") {
    val recorder = viewModel<IcTraceViewModel>().recorder
    val events by recorder.events.collectAsState()
    val context = LocalContext.current
    var captureText by remember { mutableStateOf(false) }
    var scenario by remember { mutableStateOf("unspecified") }

    Column(
      modifier = Modifier.fillMaxSize().padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      AutoMobileContentCard(modifier = Modifier.fillMaxWidth()) {
        AndroidView(
          factory = { viewContext ->
            IcTraceEditText(viewContext).apply {
              hint = "Type here with any keyboard"
              this.recorder = recorder
              captureText = captureText
            }
          },
          update = { view ->
            view.recorder = recorder
            view.captureText = captureText
          },
          modifier = Modifier.fillMaxWidth().padding(12.dp),
        )
      }
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        AutoMobileTextField(
          value = scenario,
          onValueChange = {
            scenario = it
            recorder.updateScenario(it)
          },
          label = { Text("Scenario") },
          singleLine = true,
          modifier = Modifier.weight(1f),
        )
        Row {
          Checkbox(
            checked = captureText,
            onCheckedChange = {
              captureText = it
              recorder.setCaptureText(it)
            },
          )
          Text("Include text")
        }
      }
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        AutoMobileContentButton(onClick = { recorder.clear() }) { Text("Clear") }
        AutoMobileContentButton(
          onClick = {
            exportIcTrace(recorder) { jsonl ->
              val send =
                Intent(Intent.ACTION_SEND).apply {
                  type = "text/plain"
                  putExtra(Intent.EXTRA_TEXT, jsonl)
                }
              context.startActivity(Intent.createChooser(send, "Export IC trace"))
            }
          }
        ) {
          Text("Export")
        }
      }
      Text("${events.size} events; ${recorder.droppedEventCount()} older events dropped")
      LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        items(events, key = { it.seq }) { event ->
          AutoMobileContentCard(modifier = Modifier.fillMaxWidth()) {
            Text(
              "${event.seq} +${event.elapsedMs}ms ${event.call}(${event.args})\n" +
                "selection=${event.selectionStart}..${event.selectionEnd}, " +
                "composing=${event.composingStart}..${event.composingEnd}, result=${event.result}" +
                (event.readValue?.let { ", read=$it" } ?: ""),
              modifier = Modifier.padding(8.dp),
            )
          }
        }
      }
    }
  }
}
