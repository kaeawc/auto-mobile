// Generated once by automobile:prototype/eject?id=ejectSample&platform=android.
// This file is yours: edit it freely. It is never regenerated or synced back to the spec.
// 7 TODO(eject) item(s) remain; search for TODO(eject).
package prototypes.eject

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

@Composable
fun EjectSamplePrototype() {
  val ui = remember { EjectSamplePrototypeState() }
  EjectSamplePrototypeTheme {
    Box(modifier = Modifier) {
      when (ui.top("main")) {
        "home" -> MainHomeScreen(ui)
        "detail" -> MainDetailScreen(ui)
        "settings" -> MainSettingsScreen(ui)
      }
    }
  }
}

@Composable
private fun MainHomeScreen(ui: EjectSamplePrototypeState) {
  Column(modifier = Modifier.testTag("home")) {
    Text(text = "Ejected \"sample\" costs \$5", modifier = Modifier.testTag("title"))
    Text(text = "Spans joined", modifier = Modifier.clickable { ui.push("main", "settings") })
    Row(modifier = Modifier.testTag("buttons"), verticalAlignment = Alignment.CenterVertically) {
      Button(
        onClick = {
          ui.push("main", "detail")
          /* TODO(eject): emit action */
        },
        modifier = Modifier.testTag("filled"),
      ) {
        Text(text = "Filled")
      }
      FilledTonalButton(
        onClick = {},
        modifier = Modifier,
      ) {
        Text(text = "Tonal")
      }
      ElevatedButton(
        onClick = {},
        modifier = Modifier,
      ) {
        Text(text = "Elevated")
      }
      OutlinedButton(
        onClick = {},
        modifier = Modifier,
      ) {
        Text(text = "Outlined")
      }
      TextButton(
        onClick = {
          ui.replace("main", "detail")
        },
        modifier = Modifier,
      ) {
        Text(text = "Text")
      }
      Spacer(modifier = Modifier.size(8.dp).testTag("gap"))
      VerticalDivider(modifier = Modifier)
    }
    Box(modifier = Modifier.testTag("fields")) {
      OutlinedTextField(
        value = ui.text("email"),
        onValueChange = { ui.setText("email", it) },
        modifier = Modifier.testTag("email"),
        label = { Text(text = "Email") },
        placeholder = { Text(text = "you@example.test") },
        supportingText = { Text(text = "Work address") },
        singleLine = true,
      )
      TextField(
        value = ui.text("notes"),
        onValueChange = { ui.setText("notes", it) },
        modifier = Modifier,
        label = { Text(text = "Notes") },
      )
      OutlinedTextField(
        value = ui.text("pin"),
        onValueChange = { ui.setText("pin", it) },
        modifier = Modifier,
        placeholder = { Text(text = "PIN") },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
      )
    }
    LazyColumn(modifier = Modifier.testTag("feed")) {
      item {
        Text(text = "Header", modifier = Modifier)
      }
      items(3) { index ->
        ListItem(
          headlineContent = { Text(text = "{item.name}") },
          supportingContent = { Text(text = "Row " + index) },
          modifier = Modifier.testTag("row_" + index).clickable { ui.push("main", "detail") },
        )
      }
      item {
        Text(text = "Footer", modifier = Modifier)
      }
    }
    LazyRow(modifier = Modifier) {
      items(3) { index ->
        Card(modifier = Modifier.testTag("card_" + index)) {
          Text(text = "{item.name}", modifier = Modifier)
        }
      }
    }
    HorizontalDivider(modifier = Modifier)
    // TODO(eject): searchBar at root.screens["home"].children[7] has no scaffold mapping; build it
    // by hand.
    Column(modifier = Modifier.testTag("search")) {
      Text(text = "TODO: searchBar")
      Text(text = "Suggestions", modifier = Modifier.testTag("suggestions"))
    }
    // TODO(eject): adaptive at root.screens["home"].children[8] has no scaffold mapping; build it
    // by hand.
    Column(modifier = Modifier.testTag("panes")) {
      Text(text = "TODO: adaptive")
      Text(text = "List pane", modifier = Modifier.testTag("listPane"))
      Text(text = "Detail pane", modifier = Modifier.testTag("detailPane"))
    }
  }
}

@Composable
private fun MainDetailScreen(ui: EjectSamplePrototypeState) {
  Column(modifier = Modifier.verticalScroll(rememberScrollState()).testTag("detail")) {
    Column(modifier = Modifier) {
      TextButton(
        onClick = {
          ui.pop("main")
        },
        modifier = Modifier.testTag("back"),
      ) {
        Text(text = "Back")
      }
      Row(modifier = Modifier.horizontalScroll(rememberScrollState())) {
        Text(text = "Wide", modifier = Modifier)
      }
    }
  }
}

@Composable
private fun MainSettingsScreen(ui: EjectSamplePrototypeState) {
  Box(modifier = Modifier) {
    when (ui.top("inner")) {
      "general" -> InnerGeneralScreen(ui)
      "advanced" -> InnerAdvancedScreen(ui)
    }
  }
}

@Composable
private fun InnerGeneralScreen(ui: EjectSamplePrototypeState) {
  Column(modifier = Modifier) {
    Button(
      onClick = {
        ui.push("inner", "advanced")
      },
      modifier = Modifier,
    ) {
      Text(text = "Advanced")
    }
  }
}

@Composable
private fun InnerAdvancedScreen(ui: EjectSamplePrototypeState) {
  Column(modifier = Modifier) {
    Button(
      onClick = {
        ui.popToRoot("main")
      },
      modifier = Modifier,
    ) {
      Text(text = "Home")
    }
  }
}

class EjectSamplePrototypeState {
  private val starts: Map<String, String> =
    mapOf<String, String>(
      "main" to "home",
      "inner" to "general",
    )
  private val stacks = mutableStateMapOf<String, List<String>>()
  private val texts =
    mutableStateMapOf<String, String>(
      "email" to "a@b.test",
      "notes" to "",
      "pin" to "",
      "query" to "",
    )

  fun top(stack: String): String = path(stack).last()

  fun push(stack: String, screen: String) {
    stacks[stack] = path(stack) + screen
  }

  fun pop(stack: String) {
    val p = path(stack)
    if (p.size > 1) stacks[stack] = p.dropLast(1)
  }

  fun popToRoot(stack: String) {
    stacks[stack] = listOf(starts[stack] ?: "")
  }

  fun replace(stack: String, screen: String) {
    stacks[stack] = path(stack).dropLast(1) + screen
  }

  fun text(key: String): String = texts[key] ?: ""

  fun setText(key: String, value: String) {
    texts[key] = value
  }

  private fun path(stack: String): List<String> = stacks[stack] ?: listOf(starts[stack] ?: "")
}

@Composable
fun EjectSamplePrototypeTheme(content: @Composable () -> Unit) {
  val dark = isSystemInDarkTheme()
  MaterialTheme(
    colorScheme = if (dark) EjectSamplePrototypeThemeDark else EjectSamplePrototypeThemeLight,
    content = content,
  )
}

private val EjectSamplePrototypeThemeLight =
  lightColorScheme(
    primary = Color(0xFF6750A4),
    surface = Color(0xFFFFFBFE),
  )

private val EjectSamplePrototypeThemeDark =
  darkColorScheme(
    primary = Color(0x80D0BCFF),
    surface = Color(0xFF1C1B1F),
  )
