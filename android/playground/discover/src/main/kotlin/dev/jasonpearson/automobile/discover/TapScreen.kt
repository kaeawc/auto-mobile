package dev.jasonpearson.automobile.discover

import android.os.SystemClock
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentCard
import dev.jasonpearson.automobile.design.system.components.AutoMobileExtendedFloatingActionButton
import dev.jasonpearson.automobile.design.system.components.AutoMobileFloatingActionButton
import dev.jasonpearson.automobile.design.system.theme.AutoMobileTheme
import dev.jasonpearson.automobile.sdk.TrackRecomposition
import dev.jasonpearson.automobile.storage.AnalyticsRepository
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TapScreen() {
  TrackRecomposition(id = "screen.tap", composableName = "TapScreen") {
    // Analytics tracking
    val context = LocalContext.current
    val analyticsRepository = remember { AnalyticsRepository(context) }

    val state = remember { TapControlsState() }

    // Helper function to track taps
    val trackTap = {
      state.buttonPressCount++
      analyticsRepository.trackEvent("tap")
    }

    Column(
      modifier =
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp).semantics {
          testTag = "tap_screen_content"
        },
      verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      TapScreenHeading(state.buttonPressCount)

      PressDurationTracker()

      TapButtons(trackTap)

      TapToggles(state, trackTap)

      TapIconButtons(trackTap)

      TapChips(state, trackTap)

      TapSliderProgress(state)

      TapFloatingButtons(trackTap)

      Divider()

      Text(
        text = "Long Press Scenarios",
        fontSize = 20.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.fillMaxWidth().semantics { testTag = "long_press_section_title" },
      )

      Text(
        text = "Try long press gestures to validate timing and behavior",
        fontSize = 14.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().semantics { testTag = "long_press_section_description" },
      )

      LongPressContent(modifier = Modifier.fillMaxWidth())
    }
  }
}

@Composable
private fun PressDurationTracker() {
  val coroutineScope = rememberCoroutineScope()
  var currentDurationMs by remember { mutableStateOf(0L) }
  var finalDurationMs by remember { mutableStateOf<Long?>(null) }
  var isPressing by remember { mutableStateOf(false) }
  var updateJob by remember { mutableStateOf<Job?>(null) }

  AutoMobileContentCard(
    modifier =
      Modifier.fillMaxWidth()
        .pointerInput(Unit) {
          detectTapGestures(
            onPress = {
              isPressing = true
              currentDurationMs = 0
              finalDurationMs = null
              val start = SystemClock.elapsedRealtime()
              updateJob?.cancel()
              updateJob = coroutineScope.launch {
                while (isActive) {
                  currentDurationMs = SystemClock.elapsedRealtime() - start
                  delay(16)
                }
              }

              val released = tryAwaitRelease()
              updateJob?.cancel()
              val elapsed = SystemClock.elapsedRealtime() - start
              currentDurationMs = elapsed
              if (released) {
                finalDurationMs = elapsed
              }
              isPressing = false
            },
          )
        }
        .semantics { testTag = "press_duration_tracker" },
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
  ) {
    PressDurationDisplay(currentDurationMs, finalDurationMs, isPressing)
  }
}

@Preview(showBackground = true)
@Composable
fun PreviewTapScreen() {
  AutoMobileTheme { TapScreen() }
}

internal class TapControlsState {
  var switchChecked by mutableStateOf(false)
  var checkboxChecked by mutableStateOf(false)
  var radioSelected by mutableStateOf(false)
  var sliderValue by mutableStateOf(0.5f)
  var chip1Selected by mutableStateOf(false)
  var chip2Selected by mutableStateOf(true)
  var chip3Selected by mutableStateOf(false)
  var buttonPressCount by mutableStateOf(0)
}

@Composable
private fun TapSliderProgress(state: TapControlsState) {
  // Slider and progress
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth().semantics { testTag = "slider_progress_card" },
    elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
  ) {
    Column(modifier = Modifier.padding(16.dp)) {
      Text(
        text = "Slider & Progress",
        fontSize = 18.sp,
        fontWeight = FontWeight.Bold,
        modifier =
          Modifier.padding(bottom = 8.dp).semantics {
            testTag = "slider_progress_section_title"
          },
      )

      Text(
        "Slider Value: ${(state.sliderValue * 100).toInt()}%",
        modifier = Modifier.semantics { testTag = "slider_value_text" },
      )
      Slider(
        value = state.sliderValue,
        onValueChange = { state.sliderValue = it },
        modifier =
          Modifier.fillMaxWidth().semantics {
            testTag = "slider_control"
            contentDescription = "Slider with value ${(state.sliderValue * 100).toInt()} percent"
            stateDescription = "${(state.sliderValue * 100).toInt()} percent"
          },
      )

      Spacer(modifier = Modifier.height(16.dp))

      Text(
        "Progress Indicators",
        modifier = Modifier.semantics { testTag = "progress_indicators_label" },
      )
      LinearProgressIndicator(
        modifier =
          Modifier.fillMaxWidth().semantics {
            testTag = "linear_progress_indicator"
            contentDescription =
              "Linear progress indicator showing ${(state.sliderValue * 100).toInt()} percent"
            stateDescription = "${(state.sliderValue * 100).toInt()} percent complete"
          },
        progress = { state.sliderValue },
      )

      Spacer(modifier = Modifier.height(8.dp))

      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
        CircularProgressIndicator(
          progress = { state.sliderValue },
          modifier =
            Modifier.semantics {
              testTag = "circular_progress_indicator"
              contentDescription =
                "Circular progress indicator showing ${(state.sliderValue * 100).toInt()} percent"
              stateDescription = "${(state.sliderValue * 100).toInt()} percent complete"
            },
        )
      }
    }
  }
}

@Composable
private fun TapFloatingButtons(trackTap: () -> Unit) {
  // FABs
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth().semantics { testTag = "floating_action_buttons_card" },
    elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
  ) {
    Column(modifier = Modifier.padding(16.dp)) {
      Text(
        text = "Floating Action Buttons",
        fontSize = 18.sp,
        fontWeight = FontWeight.Bold,
        modifier =
          Modifier.padding(bottom = 8.dp).semantics {
            testTag = "floating_action_buttons_section_title"
          },
      )

      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
        AutoMobileFloatingActionButton(
          onClick = trackTap,
          icon = Icons.Filled.Add,
          contentDescription = "Add",
          modifier =
            Modifier.semantics {
              testTag = "fab_add"
              contentDescription = "Add"
            },
        )

        AutoMobileExtendedFloatingActionButton(
          onClick = trackTap,
          icon = Icons.Filled.Settings,
          contentDescription = "Settings",
          text = "Settings",
          modifier =
            Modifier.semantics {
              testTag = "fab_extended_settings"
              contentDescription = "Settings"
            },
        )
      }
    }
  }
}

@Composable
private fun TapButtonCounter(buttonPressCount: Int) {
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth().semantics { testTag = "button_press_counter" },
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
  ) {
    Text(
      text = "Buttons pressed: $buttonPressCount times",
      modifier =
        Modifier.padding(16.dp).semantics {
          testTag = "button_press_counter_text"
          stateDescription = "Button press count: $buttonPressCount"
        },
      color = MaterialTheme.colorScheme.onPrimaryContainer,
      fontSize = 16.sp,
      fontWeight = FontWeight.Medium,
    )
  }
}

@Composable
private fun PressDurationDisplay(
  currentDurationMs: Long,
  finalDurationMs: Long?,
  isPressing: Boolean,
) {
  Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
    Text(text = "Press Duration Tracker", fontSize = 18.sp, fontWeight = FontWeight.Bold)
    Text(
      text = "Touch and hold to watch the timer update in real time",
      fontSize = 14.sp,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    Spacer(modifier = Modifier.height(12.dp))

    Text(
      text = "Duration: ${currentDurationMs}ms",
      fontSize = 16.sp,
      modifier = Modifier.semantics { testTag = "press_duration_current" },
    )
    Text(
      text =
        when {
          isPressing -> "Holding..."
          finalDurationMs != null -> "Final duration: ${finalDurationMs}ms"
          else -> "Tap and hold to begin"
        },
      fontSize = 12.sp,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      modifier = Modifier.semantics { testTag = "press_duration_status" },
    )
  }
}

@Composable
private fun TapScreenHeading(buttonPressCount: Int) {
  Text(
    text = "TAP SCREEN",
    fontSize = 24.sp,
    fontWeight = FontWeight.Bold,
    modifier = Modifier.fillMaxWidth().semantics { testTag = "tap_screen_title" },
  )

  Text(
    text = "Tap and long press widgets for testing gestures",
    fontSize = 16.sp,
    color = MaterialTheme.colorScheme.onSurfaceVariant,
    modifier = Modifier.fillMaxWidth().semantics { testTag = "tap_screen_description" },
  )

  // Button press counter for visual feedback
  if (buttonPressCount > 0) {
    TapButtonCounter(buttonPressCount)
  }
}
