package dev.jasonpearson.automobile.demos

import android.annotation.SuppressLint
import android.content.Context
import android.view.MotionEvent
import android.view.View
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentButton
import dev.jasonpearson.automobile.design.system.components.AutoMobileTopAppBar
import dev.jasonpearson.automobile.sdk.TrackRecomposition

/** Number of most recent events rendered as text nodes (tags `pointer_probe_event_0..N-1`). */
const val POINTER_PROBE_MAX_EVENTS = 20

/**
 * A plain View that records every MotionEvent it receives: touch, hover and generic motion (mouse,
 * stylus hover, scroll). Used to observe tool type, source, pressure, tilt and buttons for the
 * stylus/hover injection experiments (#13096).
 */
@SuppressLint("ViewConstructor")
class PointerProbeView(context: Context, private val onProbeEvent: (ProbeEvent) -> Unit) :
  View(context) {

  init {
    setBackgroundColor(PROBE_BACKGROUND_COLOR)
    contentDescription = "Pointer probe surface"
  }

  // Probe only: this View logs raw events and has no click semantics to expose to accessibility.
  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    record("touch", event)
    return true
  }

  override fun onHoverEvent(event: MotionEvent): Boolean {
    record("hover", event)
    return true
  }

  override fun onGenericMotionEvent(event: MotionEvent): Boolean {
    record("generic", event)
    return true
  }

  private fun record(via: String, event: MotionEvent) {
    onProbeEvent(probeEventOf(via, event))
  }

  private companion object {
    const val PROBE_BACKGROUND_COLOR = 0x33888888
  }
}

/** Copies the fields the probe cares about out of [event]. */
fun probeEventOf(via: String, event: MotionEvent): ProbeEvent {
  val pointers =
    (0 until event.pointerCount).map { index ->
      ProbePointer(
        id = event.getPointerId(index),
        toolType = event.getToolType(index),
        pressure = event.getPressure(index),
        tilt = event.getAxisValue(MotionEvent.AXIS_TILT, index),
        orientation = event.getAxisValue(MotionEvent.AXIS_ORIENTATION, index),
        x = event.getX(index),
        y = event.getY(index),
      )
    }
  return ProbeEvent(
    via = via,
    action = event.action,
    deviceId = event.deviceId,
    source = event.source,
    buttonState = event.buttonState,
    pointers = pointers,
  )
}

private fun isHoverAction(actionMasked: Int): Boolean =
  actionMasked == MotionEvent.ACTION_HOVER_ENTER ||
    actionMasked == MotionEvent.ACTION_HOVER_MOVE ||
    actionMasked == MotionEvent.ACTION_HOVER_EXIT

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PointerProbeScreen(onNavigateBack: () -> Unit) {
  TrackRecomposition(id = "screen.demo.pointer.probe", composableName = "PointerProbeScreen") {
    val events = remember { mutableStateListOf<String>() }
    var totalCount by remember { mutableIntStateOf(0) }
    val recordEvent: (ProbeEvent) -> Unit = { probeEvent ->
      totalCount += 1
      events.add(0, PointerProbeFormatter.format(totalCount, probeEvent))
      while (events.size > POINTER_PROBE_MAX_EVENTS) {
        events.removeAt(events.size - 1)
      }
    }

    Scaffold(
      topBar = {
        AutoMobileTopAppBar(
          title = { Text(text = "Pointer Probe") },
          navigationIcon = {
            IconButton(
              onClick = onNavigateBack,
              modifier = Modifier.semantics { testTag = "pointer_probe_back" },
            ) {
              Icon(
                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "Back",
              )
            }
          },
        )
      },
    ) { paddingValues ->
      Column(
        modifier =
          Modifier.fillMaxSize().padding(paddingValues).padding(16.dp).semantics {
            testTag = "pointer_probe_content"
          },
        verticalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        Text(
          text = "Touch, hover or draw on the gray surface below. Newest events are listed first.",
          style = MaterialTheme.typography.bodyMedium,
        )

        Text(
          text = "Events: $totalCount",
          style = MaterialTheme.typography.titleMedium,
          modifier = Modifier.semantics { testTag = "pointer_probe_count" },
        )

        AutoMobileContentButton(
          onClick = {
            events.clear()
            totalCount = 0
          },
          modifier = Modifier.fillMaxWidth().semantics { testTag = "pointer_probe_clear" },
        ) {
          Text("Clear")
        }

        Column(
          modifier =
            Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).semantics {
              testTag = "pointer_probe_log"
            },
          verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
          events.forEachIndexed { index, line ->
            Text(
              text = line,
              style = MaterialTheme.typography.bodySmall,
              modifier = Modifier.semantics { testTag = "pointer_probe_event_$index" },
            )
          }
        }

        AndroidView(
          modifier =
            Modifier.fillMaxWidth()
              .height(160.dp)
              .pointerInput(Unit) {
                // Fallback: the Compose host may not forward hover to the interop View.
                awaitPointerEventScope {
                  while (true) {
                    val pointerEvent = awaitPointerEvent()
                    val type = pointerEvent.type
                    if (
                      type == PointerEventType.Enter ||
                        type == PointerEventType.Move ||
                        type == PointerEventType.Exit
                    ) {
                      pointerEvent.motionEvent
                        ?.takeIf { isHoverAction(it.actionMasked) }
                        ?.let { recordEvent(probeEventOf("compose-hover", it)) }
                    }
                  }
                }
              }
              .semantics { testTag = "pointer_probe_surface" },
          factory = { context -> PointerProbeView(context) { recordEvent(it) } },
        )
      }
    }
  }
}
