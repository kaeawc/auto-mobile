package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.KeyboardKey
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.KeyboardUiState

@Composable
fun KeyboardScreen(
  uiState: KeyboardUiState,
  onKey: (KeyboardKey) -> Unit,
  modifier: Modifier = Modifier,
) {
  Column(
    modifier = modifier.fillMaxWidth().height(260.dp).background(Color(0xFF202124)).padding(4.dp),
    verticalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    uiState.rows.forEach { row ->
      Row(
        modifier = Modifier.fillMaxWidth().weight(1f),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
      ) {
        row.forEach { key ->
          Box(
            modifier =
              Modifier.weight(key.widthWeight)
                .fillMaxSize()
                .background(Color(0xFF44464A))
                .clickable { onKey(key) },
            contentAlignment = Alignment.Center,
          ) {
            Text(key.label, color = Color.White)
          }
        }
      }
    }
  }
}
