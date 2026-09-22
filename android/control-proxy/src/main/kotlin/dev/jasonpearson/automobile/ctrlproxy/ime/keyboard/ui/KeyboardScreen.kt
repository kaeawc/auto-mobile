package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.ui

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.tappableElement
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.KeyRepeatSchedule
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.KeyType
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.KeyboardKey
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.KeyboardUiState
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.ShiftState
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile.KeyboardProfile
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile.KeyboardStyle
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

data class KeyboardCallbacks(
  val onKey: (KeyboardKey) -> Unit,
  val onSelectProfile: (String) -> Unit,
  val onShowImePicker: () -> Unit,
)

private data class KeyboardPresentation(
  val uiState: KeyboardUiState,
  val profile: KeyboardProfile,
  val profiles: List<KeyboardProfile>,
  val callbacks: KeyboardCallbacks,
)

@Composable
fun KeyboardScreen(
  uiState: KeyboardUiState,
  profile: KeyboardProfile,
  profiles: List<KeyboardProfile>,
  callbacks: KeyboardCallbacks,
  modifier: Modifier = Modifier,
) {
  val style = profile.style
  val presentation = KeyboardPresentation(uiState, profile, profiles, callbacks)
  val keyHeight =
    if (LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE)
      style.keyHeightLandscapeDp.dp
    else style.keyHeightPortraitDp.dp
  Column(
    modifier =
      modifier
        .fillMaxWidth()
        .background(Color(style.backgroundArgb))
        // navigationBars alone is only the gesture pill; in gesture navigation the system also
        // draws the IME back and IME-switcher buttons in a taller band reported as tappableElement.
        .windowInsetsPadding(
          WindowInsets.navigationBars
            .union(WindowInsets.tappableElement)
            .union(WindowInsets.displayCutout)
            .only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal)
        ),
    verticalArrangement = Arrangement.spacedBy(style.keyGapDp.dp),
  ) {
    uiState.rows.forEach { row ->
      KeyRow(row, presentation, Modifier.fillMaxWidth().height(keyHeight))
    }
  }
}

@Composable
private fun KeyRow(
  row: List<KeyboardKey>,
  presentation: KeyboardPresentation,
  modifier: Modifier,
) {
  val style = presentation.profile.style
  Row(
    modifier = modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(style.keyGapDp.dp),
  ) {
    row.forEach { key ->
      KeyCap(key, presentation, Modifier.weight(key.widthWeight).fillMaxHeight())
    }
  }
}

@Composable
private fun KeyCap(
  key: KeyboardKey,
  presentation: KeyboardPresentation,
  modifier: Modifier,
) {
  val style = presentation.profile.style
  var pressed by remember { mutableStateOf(false) }
  var menuOpen by remember { mutableStateOf(false) }
  val currentKey by rememberUpdatedState(key)
  val currentOnKey by rememberUpdatedState(presentation.callbacks.onKey)
  val schedule = remember { KeyRepeatSchedule() }
  Box(
    modifier =
      modifier
        .clip(RoundedCornerShape(style.keyCornerRadiusDp.dp))
        .background(keyColor(key.type, presentation.uiState.shiftState, style, pressed))
        .pointerInput(key.type) {
          detectTapGestures(
            onPress = {
              pressed = true
              try {
                if (key.type == KeyType.BACKSPACE) {
                  currentOnKey(currentKey)
                  coroutineScope {
                    val repeatJob = launch {
                      var elapsedMs = schedule.initialDelayMs
                      var fired = 1
                      delay(schedule.initialDelayMs)
                      while (true) {
                        val due = schedule.firesAt(elapsedMs)
                        while (fired < due) {
                          currentOnKey(currentKey)
                          fired++
                        }
                        delay(schedule.intervalMs)
                        elapsedMs += schedule.intervalMs
                      }
                    }
                    try {
                      tryAwaitRelease()
                    } finally {
                      repeatJob.cancel()
                    }
                  }
                } else {
                  tryAwaitRelease()
                }
              } finally {
                pressed = false
              }
            },
            onTap = { if (key.type != KeyType.BACKSPACE) currentOnKey(currentKey) },
            onLongPress = if (key.type == KeyType.GLOBE) ({ menuOpen = true }) else null,
          )
        },
    contentAlignment = Alignment.Center,
  ) {
    Text(
      if (key.type == KeyType.ENTER) presentation.uiState.enterLabel else key.label,
      color = Color(style.labelArgb),
      fontSize = 14.sp,
    )
    if (key.type == KeyType.GLOBE) {
      ProfileMenu(menuOpen, presentation) { menuOpen = false }
    }
  }
}

private fun keyColor(
  type: KeyType,
  shift: ShiftState,
  style: KeyboardStyle,
  pressed: Boolean,
): Color {
  if (pressed) return Color(style.keyPressedArgb)
  if (type == KeyType.ENTER) return Color(style.accentArgb)
  if (type == KeyType.SHIFT) {
    return when (shift) {
      ShiftState.OFF -> Color(style.specialKeyArgb)
      ShiftState.SHIFTED -> lerp(Color(style.specialKeyArgb), Color(style.accentArgb), 0.5f)
      ShiftState.CAPS_LOCK -> Color(style.accentArgb)
    }
  }
  return if (type == KeyType.CHAR || type == KeyType.SPACE) Color(style.keyArgb)
  else Color(style.specialKeyArgb)
}

@Composable
private fun ProfileMenu(
  expanded: Boolean,
  presentation: KeyboardPresentation,
  dismiss: () -> Unit,
) {
  val active = presentation.profile
  val style = active.style
  DropdownMenu(expanded = expanded, onDismissRequest = dismiss) {
    presentation.profiles.forEach { profile ->
      DropdownMenuItem(
        text = {
          Text(
            (if (profile.id == active.id) "✓ " else "") + profile.displayName,
            color = if (profile.id == active.id) Color(style.accentArgb) else Color.Unspecified,
          )
        },
        onClick = {
          dismiss()
          presentation.callbacks.onSelectProfile(profile.id)
        },
      )
    }
    DropdownMenuItem(
      text = { Text("Input method picker") },
      onClick = {
        dismiss()
        presentation.callbacks.onShowImePicker()
      },
    )
  }
}
