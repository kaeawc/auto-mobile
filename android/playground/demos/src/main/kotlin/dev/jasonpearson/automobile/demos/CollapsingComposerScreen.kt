package dev.jasonpearson.automobile.demos

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentButton
import dev.jasonpearson.automobile.design.system.components.AutoMobileOutlinedTextField
import dev.jasonpearson.automobile.design.system.components.AutoMobileTopAppBar
import dev.jasonpearson.automobile.sdk.TrackRecomposition

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CollapsingComposerScreen(onNavigateBack: () -> Unit) {
  TrackRecomposition(
    id = "screen.demo.collapsing.composer",
    composableName = "CollapsingComposerScreen",
  ) {
    var draft by rememberSaveable { mutableStateOf("") }
    var collapseState by remember { mutableStateOf(ComposerCollapseState()) }
    val focusManager = LocalFocusManager.current
    val imeVisible = WindowInsets.isImeVisible
    LaunchedEffect(imeVisible) {
      val next = collapseState.onImeVisibilityChanged(imeVisible)
      if (collapseState.isExpanded && !next.isExpanded) {
        focusManager.clearFocus(force = true)
      }
      collapseState = next
    }

    Scaffold(topBar = { CollapsingComposerTopBar(onNavigateBack) }) { paddingValues ->
      Column(
        modifier =
          Modifier.fillMaxSize().padding(paddingValues).imePadding().padding(16.dp).semantics {
            testTag = "collapsing_composer_content"
          },
        verticalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        Text(
          text = "Hide the keyboard to collapse the composer. Tap to write again.",
          style = MaterialTheme.typography.bodyMedium,
        )
        if (collapseState.isExpanded) {
          ExpandedComposer(draft = draft, onDraftChange = { draft = it })
        } else {
          AutoMobileContentButton(
            onClick = { collapseState = collapseState.expand() },
            modifier =
              Modifier.fillMaxWidth().semantics { testTag = "collapsing_composer_collapsed_bar" },
          ) {
            Text("Tap to write")
          }
        }
        Text(
          text = "Draft: $draft",
          modifier = Modifier.semantics { testTag = "collapsing_composer_draft" },
        )
      }
    }
  }
}

@Composable
private fun ExpandedComposer(draft: String, onDraftChange: (String) -> Unit) {
  val focusRequester = remember { FocusRequester() }
  val keyboardController = LocalSoftwareKeyboardController.current
  AutoMobileOutlinedTextField(
    value = draft,
    onValueChange = onDraftChange,
    placeholder = { Text("What do you want to say?") },
    maxLines = 4,
    modifier =
      Modifier.fillMaxWidth().focusRequester(focusRequester).semantics {
        testTag = "collapsing_composer_field"
      },
  )
  LaunchedEffect(Unit) {
    focusRequester.requestFocus()
    keyboardController?.show()
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CollapsingComposerTopBar(onNavigateBack: () -> Unit) {
  AutoMobileTopAppBar(
    title = { Text("Collapsing Composer") },
    navigationIcon = {
      IconButton(
        onClick = onNavigateBack,
        modifier = Modifier.semantics { testTag = "collapsing_composer_back" },
      ) {
        Icon(imageVector = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
      }
    },
  )
}
