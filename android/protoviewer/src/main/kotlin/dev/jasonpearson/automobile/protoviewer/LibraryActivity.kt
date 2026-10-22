package dev.jasonpearson.automobile.protoviewer

import android.content.ClipData
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
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
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import java.io.File
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class LibraryActivity : ComponentActivity() {
  private val services
    get() = (application as ProtoViewerApplication).services

  private var entries by mutableStateOf<LibraryResult<List<LibraryEntry>>?>(null)
  private var actionFailed by mutableStateOf(false)
  private var localNetworkDenied by mutableStateOf(false)
  private lateinit var networkSettings: NetworkSettings

  private var pendingExport: LibraryShareExport? by mutableStateOf(null)
  private var sharedName: String? = null
  private var preparingShare = false
  private val shareLauncher =
    registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
      cleanupExport()
    }

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    outState.putString("sharedExport", sharedName)
    outState.putBoolean("localNetworkDenied", localNetworkDenied)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    sharedName = savedInstanceState?.getString("sharedExport")
    localNetworkDenied = savedInstanceState?.getBoolean("localNetworkDenied") ?: false
    networkSettings =
      NetworkSettings(
        services.settings,
        services.localNetworkPermission(this) { granted ->
          networkSettings.onPermissionResult(granted)
          localNetworkDenied = !granted
        },
        Build.VERSION.SDK_INT,
      )
    setContent {
      ProtoViewerTheme {
        val allowNetwork by services.settings.allowNetwork.collectAsState()
        LibraryScreen(
          entries,
          actionFailed,
          ::open,
          ::share,
          ::delete,
          allowNetwork = allowNetwork,
          localNetworkDenied = localNetworkDenied,
          setAllowNetwork = { enabled ->
            localNetworkDenied = false
            networkSettings.setEnabled(enabled)
          },
        )
        pendingExport?.let { exported ->
          AlertDialog(
            onDismissRequest = { cancelShare() },
            title = { Text(getString(R.string.share_warning_title)) },
            text = { Text(exported.warnings.joinToString("\n") { "${it.code}: ${it.path}" }) },
            confirmButton = {
              TextButton(onClick = { send(exported) }) { Text(getString(R.string.share)) }
            },
            dismissButton = {
              TextButton(onClick = { cancelShare() }) { Text(getString(R.string.cancel)) }
            },
          )
        }
      }
    }
  }

  override fun onResume() {
    super.onResume()
    lifecycleScope.launch {
      entries =
        withContext(services.io) {
          services.clearStaleExports()
          services.repository.list()
        }
    }
  }

  private fun delete(entry: LibraryEntry) {
    lifecycleScope.launch {
      ViewerLaunch.close(this@LibraryActivity, entry.libraryId)
      actionFailed =
        withContext(services.io) { services.repository.delete(entry.libraryId) } is
          LibraryResult.Failure
      entries = withContext(services.io) { services.repository.list() }
    }
  }

  override fun onDestroy() {
    if (pendingExport != null) cancelShare()
    super.onDestroy()
  }

  private fun share(entry: LibraryEntry) {
    if (preparingShare || sharedName != null || pendingExport != null) return
    preparingShare = true
    lifecycleScope.launch {
      var abandoned: LibraryShareExport? = null
      try {
        val result =
          withContext(services.io) {
            services.clearStaleExports()
            services.sharer?.prepare(entry.libraryId).also {
              if (it is LibraryResult.Success) abandoned = it.value
            }
          }
        if (result is LibraryResult.Success) {
          if (result.value.warnings.isEmpty()) send(result.value) else pendingExport = result.value
          abandoned = null
        } else actionFailed = true
      } finally {
        preparingShare = false
        abandoned?.let { exported ->
          services.flushScope.launch(services.io) { services.sharer?.cleanup(exported.name) }
        }
      }
    }
  }

  @Suppress(
    "TooGenericExceptionCaught",
  ) // Platform/provider launch failures all require export cleanup.
  private fun send(exported: LibraryShareExport) {
    pendingExport = null
    sharedName = exported.name
    try {
      val uri =
        FileProvider.getUriForFile(
          this,
          "$packageName.exports",
          File(cacheDir, "export/${exported.name}"),
        )
      val send =
        Intent(Intent.ACTION_SEND).apply {
          type = PROTOTYPE_BUNDLE_MIME
          putExtra(Intent.EXTRA_STREAM, uri)
          clipData = ClipData.newRawUri("Prototype", uri)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
      shareLauncher.launch(Intent.createChooser(send, getString(R.string.share)))
    } catch (error: RuntimeException) {
      Log.w("ProtoViewerShare", "Cannot launch share chooser", error)
      actionFailed = true
      cleanupExport()
    }
  }

  private fun cancelShare() {
    sharedName = pendingExport?.name
    pendingExport = null
    cleanupExport()
  }

  private fun cleanupExport() {
    val name = sharedName ?: return
    sharedName = null
    services.flushScope.launch(services.io) { services.sharer?.cleanup(name) }
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
@Suppress("LongParameterList") // Independent library actions and explicit settings UI state.
internal fun LibraryScreen(
  result: LibraryResult<List<LibraryEntry>>?,
  actionFailed: Boolean,
  open: (LibraryEntry, Boolean, Boolean) -> Unit,
  share: (LibraryEntry) -> Unit = {},
  delete: (LibraryEntry) -> Unit = {},
  allowNetwork: Boolean = false,
  localNetworkDenied: Boolean = false,
  setAllowNetwork: (Boolean) -> Unit = {},
) {
  Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(16.dp)) {
    Text(stringResource(R.string.app_name))
    val networkLabel = stringResource(R.string.allow_network)
    ListItem(
      headlineContent = { Text(networkLabel) },
      supportingContent = { Text(stringResource(R.string.allow_network_explanation)) },
      trailingContent = {
        Switch(
          checked = allowNetwork,
          onCheckedChange = setAllowNetwork,
          modifier =
            Modifier.testTag("allow-network").semantics {
              contentDescription = networkLabel
            },
        )
      },
    )
    if (localNetworkDenied) Text(stringResource(R.string.local_network_denied))
    if (actionFailed) Text(stringResource(R.string.action_error))
    when (result) {
      null -> Text(stringResource(R.string.loading))
      is LibraryResult.Failure -> Text(stringResource(R.string.library_error))
      is LibraryResult.Success -> {
        if (result.value.isEmpty()) Text(stringResource(R.string.empty_library))
        LazyColumn {
          items(result.value, key = { it.libraryId }) { entry ->
            LibraryRow(entry, open, share, delete)
          }
        }
      }
    }
  }
}

@Composable
private fun LibraryRow(
  entry: LibraryEntry,
  open: (LibraryEntry, Boolean, Boolean) -> Unit,
  share: (LibraryEntry) -> Unit,
  delete: (LibraryEntry) -> Unit,
) {
  var confirm by remember { mutableStateOf(false) }
  var confirmDelete by remember { mutableStateOf(false) }
  ListItem(
    headlineContent = { Text(entry.label) },
    modifier =
      Modifier.fillMaxWidth().testTag("library-${entry.libraryId}").clickable {
        open(entry, false, false)
      },
    trailingContent = {
      LibraryEntryMenu(entry, open, share, { confirm = true }, { confirmDelete = true })
    },
  )

  if (confirmDelete)
    AlertDialog(
      onDismissRequest = { confirmDelete = false },
      title = { Text(stringResource(R.string.delete_title)) },
      text = { Text(stringResource(R.string.delete_body)) },
      confirmButton = {
        TextButton(
          modifier = Modifier.testTag("confirm-delete"),
          onClick = {
            confirmDelete = false
            delete(entry)
          },
        ) {
          Text(stringResource(R.string.delete))
        }
      },
      dismissButton = {
        TextButton(onClick = { confirmDelete = false }) { Text(stringResource(R.string.cancel)) }
      },
    )
  if (confirm)
    ResetConfirmation({ confirm = false }) {
      confirm = false
      open(entry, true, true)
    }
}

@Composable
private fun LibraryEntryMenu(
  entry: LibraryEntry,
  open: (LibraryEntry, Boolean, Boolean) -> Unit,
  share: (LibraryEntry) -> Unit,
  reset: () -> Unit,
  delete: () -> Unit,
) {
  var expanded by remember { mutableStateOf(false) }
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
        text = { Text(stringResource(R.string.share)) },
        onClick = {
          expanded = false
          share(entry)
        },
      )
      DropdownMenuItem(
        text = { Text(stringResource(R.string.delete)) },
        onClick = {
          expanded = false
          delete()
        },
      )
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
          reset()
        },
      )
    }
  }
}
