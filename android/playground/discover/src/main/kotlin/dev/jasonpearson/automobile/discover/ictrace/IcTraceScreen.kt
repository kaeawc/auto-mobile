package dev.jasonpearson.automobile.discover.ictrace

import android.content.Intent
import android.util.Log
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.jasonpearson.automobile.sdk.TrackRecomposition

@Composable
fun IcTraceScreen() {
  TrackRecomposition(id = "screen.icTrace", composableName = "IcTraceScreen") {
    val recorder = remember { IcTraceRecorder() }
    val events by recorder.events.collectAsState()
    val context = LocalContext.current

    Column(
      modifier = Modifier.fillMaxSize().padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Card(modifier = Modifier.fillMaxWidth()) {
        AndroidView(
          factory = { viewContext ->
            IcTraceEditText(viewContext).apply {
              hint = "Type here with any keyboard"
              this.recorder = recorder
              captureText = true
            }
          },
          update = { view ->
            view.recorder = recorder
            view.captureText = true
          },
          modifier = Modifier.fillMaxWidth().padding(12.dp),
        )
      }
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { recorder.clear() }) { Text("Clear") }
        Button(
          onClick = {
            val jsonl = IcTraceFormatter.format(recorder.snapshot())
            jsonl.lineSequence().filter { it.isNotEmpty() }.forEach { Log.i("IcTrace", it) }
            val send =
              Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, jsonl)
              }
            context.startActivity(Intent.createChooser(send, "Export IC trace"))
          }
        ) {
          Text("Export")
        }
      }
      Text("${events.size} events")
      LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        items(events, key = { it.seq }) { event ->
          Card(modifier = Modifier.fillMaxWidth()) {
            Text(
              "${event.seq} +${event.elapsedMs}ms ${event.call}(${event.args})\n" +
                "selection=${event.selectionStart}..${event.selectionEnd}, " +
                "composing=${event.composingStart}..${event.composingEnd}",
              modifier = Modifier.padding(8.dp),
            )
          }
        }
      }
    }
  }
}
