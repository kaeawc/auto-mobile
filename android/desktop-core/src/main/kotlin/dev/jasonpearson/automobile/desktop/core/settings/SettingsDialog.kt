package dev.jasonpearson.automobile.desktop.core.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/**
 * Settings panel composable that can be shown inline or in a dialog.
 * Mirrors the IDE plugin's settings UI with Material3 styling.
 */
@Composable
fun SettingsPanel(
    settings: SettingsProvider,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors

  Column(
      modifier = modifier
          .fillMaxWidth()
          .background(MaterialTheme.colorScheme.surface)
          .padding(24.dp)
          .verticalScroll(rememberScrollState()),
  ) {
    // Header
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
      Text("Settings", fontSize = 20.sp, fontWeight = FontWeight.Bold)
      Box(
          modifier = Modifier
              .clickable(onClick = onClose)
              .pointerHoverIcon(PointerIcon.Hand)
              .background(colors.text.normal.copy(alpha = 0.08f), RoundedCornerShape(4.dp))
              .padding(horizontal = 12.dp, vertical = 6.dp),
      ) {
        Text("Close", fontSize = 13.sp)
      }
    }

    Spacer(Modifier.height(24.dp))

    // === IDE Preferences ===
    SectionHeader("IDE Preferences")
    Text(
        "Choose which application opens source files from stack traces.",
        fontSize = 12.sp,
        color = colors.text.normal.copy(alpha = 0.6f),
    )
    Spacer(Modifier.height(12.dp))

    var androidIde by remember { mutableStateOf(settings.androidIde) }
    var iosIde by remember { mutableStateOf(settings.iosIde) }

    IdeSelector(
        label = "Android / Kotlin / Java",
        value = androidIde,
        options = listOf("auto" to "Auto (Android Studio)", "android-studio" to "Android Studio", "intellij" to "IntelliJ IDEA", "vscode" to "VS Code"),
        onSelected = { androidIde = it; settings.androidIde = it },
    )
    Spacer(Modifier.height(8.dp))
    IdeSelector(
        label = "Swift / Objective-C",
        value = iosIde,
        options = listOf("auto" to "Auto (Xcode)", "xcode" to "Xcode", "vscode" to "VS Code"),
        onSelected = { iosIde = it; settings.iosIde = it },
    )

    Spacer(Modifier.height(24.dp))
    HorizontalDivider(color = colors.text.normal.copy(alpha = 0.1f))
    Spacer(Modifier.height(24.dp))

    // === Test Plan Authoring ===
    SectionHeader("Test Plan Authoring")

    var yamlLinting by remember { mutableStateOf(settings.enableYamlLinting) }
    Row(verticalAlignment = Alignment.CenterVertically) {
      Checkbox(
          checked = yamlLinting,
          onCheckedChange = { yamlLinting = it; settings.enableYamlLinting = it },
      )
      Text("Enable YAML validation for test plans", fontSize = 13.sp)
    }
    Text(
        "Validates test plan YAML files against the schema for immediate feedback on errors and deprecated fields.",
        fontSize = 12.sp,
        color = colors.text.normal.copy(alpha = 0.6f),
        modifier = Modifier.padding(start = 28.dp),
    )

    Spacer(Modifier.height(24.dp))
    HorizontalDivider(color = colors.text.normal.copy(alpha = 0.1f))
    Spacer(Modifier.height(24.dp))

    // === Recording ===
    SectionHeader("Recording")

    var outputDir by remember { mutableStateOf(settings.testPlanOutputDirectory) }
    Text(
        "Test plan output directory (relative to project root or absolute)",
        fontSize = 12.sp,
        color = colors.text.normal.copy(alpha = 0.6f),
    )
    Spacer(Modifier.height(4.dp))
    TextField(
        value = outputDir,
        onValueChange = { outputDir = it; settings.testPlanOutputDirectory = it },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    Text(
        "New recordings are saved here and opened in the editor after stopping.",
        fontSize = 12.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
    )

    Spacer(Modifier.height(24.dp))
    HorizontalDivider(color = colors.text.normal.copy(alpha = 0.1f))
    Spacer(Modifier.height(24.dp))

    // === Failures ===
    SectionHeader("Failures")

    var dateRange by remember { mutableStateOf(settings.failuresDateRange) }
    Text("Default date range", fontSize = 12.sp, color = colors.text.normal.copy(alpha = 0.6f))
    Spacer(Modifier.height(4.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
      listOf("1h", "24h", "3d", "7d", "30d").forEach { range ->
        Box(
            modifier = Modifier
                .clickable { dateRange = range; settings.failuresDateRange = range }
                .pointerHoverIcon(PointerIcon.Hand)
                .background(
                    if (dateRange == range) MaterialTheme.colorScheme.primary.copy(alpha = 0.2f)
                    else colors.text.normal.copy(alpha = 0.05f),
                    RoundedCornerShape(4.dp),
                )
                .padding(horizontal = 10.dp, vertical = 6.dp),
        ) {
          Text(
              range,
              fontSize = 12.sp,
              color = if (dateRange == range) MaterialTheme.colorScheme.primary else colors.text.normal,
          )
        }
      }
    }
  }
}

@Composable
private fun SectionHeader(title: String) {
  Text(title, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
  Spacer(Modifier.height(8.dp))
}

@Composable
private fun IdeSelector(
    label: String,
    value: String,
    options: List<Pair<String, String>>,
    onSelected: (String) -> Unit,
) {
  val colors = SharedTheme.globalColors
  Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(label, fontSize = 13.sp, modifier = Modifier.width(200.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
      options.forEach { (key, displayName) ->
        Box(
            modifier = Modifier
                .clickable { onSelected(key) }
                .pointerHoverIcon(PointerIcon.Hand)
                .background(
                    if (value == key) MaterialTheme.colorScheme.primary.copy(alpha = 0.2f)
                    else colors.text.normal.copy(alpha = 0.05f),
                    RoundedCornerShape(4.dp),
                )
                .padding(horizontal = 10.dp, vertical = 6.dp),
        ) {
          Text(
              displayName,
              fontSize = 12.sp,
              color = if (value == key) MaterialTheme.colorScheme.primary else colors.text.normal,
          )
        }
      }
    }
  }
}
