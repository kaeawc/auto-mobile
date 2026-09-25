package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/** Show SDK-provider failures plainly; preserve full detail for investigation. */
@Composable
internal fun StorageLoadError(message: String, errorCode: String?) {
  val color = SharedTheme.globalColors.text.normal.copy(alpha = 0.7f)
  if (errorCode == "PROVIDER_UNAVAILABLE") {
    var expanded by remember(message) { mutableStateOf(false) }
    Column(modifier = Modifier.fillMaxWidth()) {
      Text(
        "This app doesn't include the AutoMobile SDK provider. Use a build with the SDK to inspect its storage.",
        fontSize = 11.sp,
        color = color,
      )
      Text(
        if (expanded) "Hide details" else "Show details",
        modifier = Modifier.clickable { expanded = !expanded }.padding(vertical = 4.dp),
        fontSize = 11.sp,
        color = color,
      )
      if (expanded)
        Text(message, fontSize = 11.sp, color = color, fontFamily = FontFamily.Monospace)
    }
  } else {
    Text(message, fontSize = 11.sp, color = color, fontFamily = FontFamily.Monospace)
  }
}
