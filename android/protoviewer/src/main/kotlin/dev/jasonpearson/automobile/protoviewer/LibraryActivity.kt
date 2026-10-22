package dev.jasonpearson.automobile.protoviewer

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class LibraryActivity : ComponentActivity() {
  private val services
    get() = (application as ProtoViewerApplication).services

  private var entries by mutableStateOf<LibraryResult<List<LibraryEntry>>?>(null)
  private var actionFailed by mutableStateOf(false)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent { ProtoViewerTheme { LibraryScreen(entries, actionFailed, ::open) } }
  }

  override fun onResume() {
    super.onResume()
    lifecycleScope.launch { entries = withContext(services.io) { services.repository.list() } }
  }

  private fun open(entry: LibraryEntry, reset: Boolean, relaunch: Boolean) {
    lifecycleScope.launch {
      actionFailed = false
      if (relaunch && services.restart(entry.libraryId, reset)) return@launch
      if (reset) {
        val result = withContext(services.io) { services.repository.resetStorage(entry.libraryId) }
        if (result is LibraryResult.Failure) {
          actionFailed = true
          return@launch
        }
      }
      ViewerLaunch.open(this@LibraryActivity, entry.libraryId, relaunch)
    }
  }
}

@Composable
internal fun LibraryScreen(
  result: LibraryResult<List<LibraryEntry>>?,
  actionFailed: Boolean,
  open: (LibraryEntry, Boolean, Boolean) -> Unit,
) {
  Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(16.dp)) {
    Text(stringResource(R.string.app_name))
    if (actionFailed) Text(stringResource(R.string.action_error))
    when (result) {
      null -> Text(stringResource(R.string.loading))
      is LibraryResult.Failure -> Text(stringResource(R.string.library_error))
      is LibraryResult.Success -> {
        if (result.value.isEmpty()) Text(stringResource(R.string.empty_library))
        LazyColumn {
          items(result.value, key = { it.libraryId }) { entry -> LibraryRow(entry, open) }
        }
      }
    }
  }
}

@Composable
private fun LibraryRow(entry: LibraryEntry, open: (LibraryEntry, Boolean, Boolean) -> Unit) {
  var expanded by remember { mutableStateOf(false) }
  var confirm by remember { mutableStateOf(false) }
  ListItem(
    headlineContent = { Text(entry.label) },
    modifier =
      Modifier.fillMaxWidth().testTag("library-${entry.libraryId}").clickable {
        open(entry, false, false)
      },
    trailingContent = {
      Column {
        val description = stringResource(R.string.more, entry.label)
        IconButton(
          onClick = { expanded = true },
          modifier = Modifier.semantics { contentDescription = description },
        ) {
          Text("⋮")
        }
        DropdownMenu(expanded, onDismissRequest = { expanded = false }) {
          DropdownMenuItem(
            text = { Text(stringResource(R.string.relaunch)) },
            onClick = {
              expanded = false
              open(entry, false, true)
            },
          )
          DropdownMenuItem(
            text = { Text(stringResource(R.string.reset)) },
            onClick = {
              expanded = false
              confirm = true
            },
          )
        }
      }
    },
  )
  if (confirm)
    ResetConfirmation({ confirm = false }) {
      confirm = false
      open(entry, true, true)
    }
}
