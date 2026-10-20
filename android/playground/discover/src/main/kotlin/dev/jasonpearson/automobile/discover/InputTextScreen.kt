package dev.jasonpearson.automobile.discover

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentCard
import dev.jasonpearson.automobile.design.system.components.AutoMobileFilterChip
import dev.jasonpearson.automobile.design.system.components.AutoMobileIconButton
import dev.jasonpearson.automobile.design.system.components.AutoMobileOutlinedTextField
import dev.jasonpearson.automobile.design.system.components.AutoMobileTextField
import dev.jasonpearson.automobile.design.system.theme.AutoMobileTheme
import dev.jasonpearson.automobile.sdk.TrackRecomposition

@Composable
fun InputTextScreen() {
  TrackRecomposition(id = "screen.inputText", composableName = "InputTextScreen") {
    val state = remember { InputTextState() }

    LazyColumn(
      modifier = Modifier.fillMaxSize().padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      // Header
      item {
        Text(
          text = "INPUT TEXT SCREEN",
          fontSize = 24.sp,
          fontWeight = FontWeight.Bold,
          modifier = Modifier.fillMaxWidth(),
        )
      }

      item {
        Text(
          text = "Comprehensive text input and display components",
          fontSize = 16.sp,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
          modifier = Modifier.fillMaxWidth(),
        )
      }

      // Basic Text Fields
      item {
        BasicTextFields(state)
      }

      // Password Field
      item {
        PasswordField(state)
      }

      // Multiline Text Area
      item {
        MultilineTextArea(state)
      }

      // Numeric and Search Fields
      item {
        SpecializedInputFields(state)
      }

      // Chip Input
      item {
        ChipInputTags(state)
      }

      // Rich Text Display
      item {
        RichTextDisplay()
      }

      // URL Highlighted Text
      item {
        ClickableUrlText()
      }

      // Selectable Text
      item {
        SelectableTextDisplay()
      }
    }
  }
}

@Preview(showBackground = true)
@Composable
fun PreviewInputTextScreen() {
  AutoMobileTheme { InputTextScreen() }
}

private class InputTextState {
  var basicText by mutableStateOf("")
  var emailText by mutableStateOf("")
  var passwordText by mutableStateOf("")
  var passwordVisible by mutableStateOf(false)
  var multilineText by mutableStateOf("")
  var numericText by mutableStateOf("")
  var searchText by mutableStateOf("")
  var selectedChips by mutableStateOf(setOf<String>())
  var validationErrorText by mutableStateOf("")
}

@Composable
private fun BasicTextFields(state: InputTextState) {
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth(),
    elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
  ) {
    Column(modifier = Modifier.padding(16.dp)) {
      Text(
        text = "Basic Text Fields",
        fontSize = 18.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(bottom = 8.dp),
      )

      AutoMobileTextField(
        value = state.basicText,
        onValueChange = { state.basicText = it },
        label = { Text("Basic Text Field") },
        placeholder = { Text("Enter some text...") },
        modifier = Modifier.fillMaxWidth(),
      )

      Spacer(modifier = Modifier.height(8.dp))

      AutoMobileOutlinedTextField(
        value = state.emailText,
        onValueChange = {
          state.emailText = it
          state.validationErrorText =
            if (it.isNotEmpty() && !it.contains("@")) {
              "Please enter a valid email"
            } else ""
        },
        label = { Text("Email") },
        placeholder = { Text("Enter your email") },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
        isError = state.validationErrorText.isNotEmpty(),
        supportingText =
          if (state.validationErrorText.isNotEmpty()) {
            { Text(state.validationErrorText, color = MaterialTheme.colorScheme.error) }
          } else null,
        modifier = Modifier.fillMaxWidth(),
      )
    }
  }
}

@Composable
private fun PasswordField(state: InputTextState) {
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth(),
    elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
  ) {
    Column(modifier = Modifier.padding(16.dp)) {
      Text(
        text = "Password Field",
        fontSize = 18.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(bottom = 8.dp),
      )

      AutoMobileOutlinedTextField(
        value = state.passwordText,
        onValueChange = { state.passwordText = it },
        label = { Text("Password") },
        placeholder = { Text("Enter password") },
        visualTransformation =
          if (state.passwordVisible) {
            VisualTransformation.None
          } else {
            PasswordVisualTransformation()
          },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        trailingIcon = {
          AutoMobileIconButton(onClick = { state.passwordVisible = !state.passwordVisible }) {
            Icon(
              imageVector =
                if (state.passwordVisible) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
              contentDescription = if (state.passwordVisible) "Hide password" else "Show password",
            )
          }
        },
        modifier = Modifier.fillMaxWidth(),
      )
    }
  }
}

@Composable
private fun MultilineTextArea(state: InputTextState) {
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth(),
    elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
  ) {
    Column(modifier = Modifier.padding(16.dp)) {
      Text(
        text = "Multiline Text Area",
        fontSize = 18.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(bottom = 8.dp),
      )

      AutoMobileOutlinedTextField(
        value = state.multilineText,
        onValueChange = { state.multilineText = it },
        label = { Text("Comments") },
        placeholder = { Text("Enter your comments here...") },
        minLines = 3,
        maxLines = 5,
        modifier = Modifier.fillMaxWidth(),
      )
    }
  }
}

@Composable
private fun SpecializedInputFields(state: InputTextState) {
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth(),
    elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
  ) {
    Column(modifier = Modifier.padding(16.dp)) {
      Text(
        text = "Specialized Input Fields",
        fontSize = 18.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(bottom = 8.dp),
      )

      AutoMobileOutlinedTextField(
        value = state.numericText,
        onValueChange = { newValue ->
          if (newValue.all { it.isDigit() || it == '.' }) {
            state.numericText = newValue
          }
        },
        label = { Text("Numeric Input") },
        placeholder = { Text("Enter a number") },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        modifier = Modifier.fillMaxWidth(),
      )

      Spacer(modifier = Modifier.height(8.dp))

      AutoMobileOutlinedTextField(
        value = state.searchText,
        onValueChange = { state.searchText = it },
        label = { Text("Search") },
        placeholder = { Text("Search for something...") },
        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = "Search") },
        trailingIcon =
          if (state.searchText.isNotEmpty()) {
            {
              AutoMobileIconButton(onClick = { state.searchText = "" }) {
                Icon(Icons.Filled.Clear, contentDescription = "Clear")
              }
            }
          } else null,
        modifier = Modifier.fillMaxWidth(),
      )
    }
  }
}

@Composable
private fun ChipInputTags(state: InputTextState) {
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth(),
    elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
  ) {
    Column(modifier = Modifier.padding(16.dp)) {
      Text(
        text = "Chip Input Tags",
        fontSize = 18.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(bottom = 8.dp),
      )

      Text(
        text = "Select your interests:",
        fontSize = 14.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 8.dp),
      )

      val chipOptions = listOf("Technology", "Sports", "Music", "Art", "Travel", "Food")

      ChipOptionsRow(chipOptions.take(3), state)
      Spacer(modifier = Modifier.height(8.dp))
      ChipOptionsRow(chipOptions.drop(3), state)

      if (state.selectedChips.isNotEmpty()) {
        Spacer(modifier = Modifier.height(8.dp))
        Text(
          text = "Selected: ${state.selectedChips.joinToString(", ")}",
          fontSize = 12.sp,
          color = MaterialTheme.colorScheme.primary,
        )
      }
    }
  }
}

@Composable
private fun ChipOptionsRow(options: List<String>, state: InputTextState) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    options.forEach { chip ->
      AutoMobileFilterChip(
        selected = state.selectedChips.contains(chip),
        onClick = {
          state.selectedChips =
            if (state.selectedChips.contains(chip)) {
              state.selectedChips - chip
            } else {
              state.selectedChips + chip
            }
        },
        label = { Text(chip) },
      )
    }
  }
}
