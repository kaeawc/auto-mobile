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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
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

  private val received by lazy { ReceivedContentHandler(this, services) }
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
          ReceivedContentActions(
            report = { actionFailed = !received.report(it) },
            hide = { entry -> lifecycleScope.launch { entries = received.hide(entry, entries) } },
            block = { entry -> lifecycleScope.launch { entries = received.block(entry, entries) } },
          ),
          allowNetwork = allowNetwork,
          localNetworkDenied = localNetworkDenied,
          setAllowNetwork = { enabled ->
            localNetworkDenied = false
            networkSettings.setEnabled(enabled)
          },
          openLicenses = { startActivity(Intent(this, LicensesActivity::class.java)) },
          openSecurityPolicy = { actionFailed = !launchSecurityPolicy(this) },
          openContact = {
            actionFailed = !launchReport(this, getString(R.string.contact_subject), "")
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

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) {
      recheckLocalNetworkPermission(services.settings, services.localNetworkGrant, this) {
        localNetworkDenied = true
      }
    }
  }

  override fun onResume() {
    super.onResume()
    recheckLocalNetworkPermission(services.settings, services.localNetworkGrant, this) {
      localNetworkDenied = true
    }
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
          clipData = ClipData.newRawUri(getString(R.string.app_name), uri)
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
  received: ReceivedContentActions = ReceivedContentActions(),
  allowNetwork: Boolean = false,
  localNetworkDenied: Boolean = false,
  setAllowNetwork: (Boolean) -> Unit = {},
  openLicenses: () -> Unit = {},
  openSecurityPolicy: () -> Unit = {},
  openContact: () -> Unit = {},
) {
  LazyColumn(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(16.dp)) {
    item {
      Text(stringResource(R.string.app_name), Modifier.semantics { heading() })
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
    }
    if (localNetworkDenied) item { Text(stringResource(R.string.local_network_denied)) }
    item {
      ListItem(
        headlineContent = { Text(stringResource(R.string.open_source_licenses)) },
        modifier = Modifier.fillMaxWidth().testTag("open-licenses").clickable { openLicenses() },
      )
    }
    item {
      ListItem(
        headlineContent = { Text(stringResource(R.string.security_policy)) },
        modifier =
          Modifier.fillMaxWidth().testTag("open-security-policy").clickable {
            openSecurityPolicy()
          },
      )
    }
    item {
      ListItem(
        headlineContent = { Text(stringResource(R.string.contact)) },
        supportingContent = { Text(REPORT_CONTACT_EMAIL) },
        modifier = Modifier.fillMaxWidth().testTag("open-contact").clickable { openContact() },
      )
    }
    if (actionFailed) item { Text(stringResource(R.string.action_error)) }
    when (result) {
      null -> item { Text(stringResource(R.string.loading)) }
      is LibraryResult.Failure -> item { Text(stringResource(R.string.library_error)) }
      is LibraryResult.Success -> {
        if (result.value.isEmpty()) item { Text(stringResource(R.string.empty_library)) }
        items(result.value, key = { it.libraryId }) { entry ->
          LibraryRow(entry, open, share, delete, received)
        }
      }
    }
  }
}

/** The confirmation a row's menu asked for; at most one is open at a time. */
private enum class RowDialog {
  Reset,
  Delete,
  Hide,
  Block,
}

@Composable
private fun LibraryRow(
  entry: LibraryEntry,
  open: (LibraryEntry, Boolean, Boolean) -> Unit,
  share: (LibraryEntry) -> Unit,
  delete: (LibraryEntry) -> Unit,
  received: ReceivedContentActions,
) {
  var dialog by remember { mutableStateOf<RowDialog?>(null) }
  val openLabel = stringResource(R.string.open_prototype, entry.label)
  ListItem(
    headlineContent = { Text(entry.label) },
    modifier =
      Modifier.fillMaxWidth().testTag("library-${entry.libraryId}").clickable(
        role = Role.Button,
        onClickLabel = openLabel,
      ) {
        open(entry, false, false)
      },
    trailingContent = { LibraryEntryMenu(entry, open, share, received.report) { dialog = it } },
  )
  dialog?.let { shown ->
    RowConfirmation(entry, shown, { dialog = null }) {
      dialog = null
      when (shown) {
        RowDialog.Reset -> open(entry, true, true)
        RowDialog.Delete -> delete(entry)
        RowDialog.Hide -> received.hide(entry)
        RowDialog.Block -> received.block(entry)
      }
    }
  }
}

@Composable
private fun RowConfirmation(
  entry: LibraryEntry,
  dialog: RowDialog,
  dismiss: () -> Unit,
  confirm: () -> Unit,
) {
  val host = entry.sourceHost.orEmpty()
  when (dialog) {
    RowDialog.Reset -> ResetConfirmation(dismiss, confirm)
    RowDialog.Delete ->
      ConfirmationDialog(
        "confirm-delete",
        stringResource(R.string.delete_title),
        stringResource(R.string.delete_body),
        stringResource(R.string.delete),
        dismiss,
        confirm,
      )
    RowDialog.Hide ->
      ConfirmationDialog(
        "confirm-hide",
        stringResource(R.string.hide_title),
        stringResource(R.string.hide_body),
        stringResource(R.string.hide),
        dismiss,
        confirm,
      )
    RowDialog.Block ->
      ConfirmationDialog(
        "confirm-block",
        stringResource(R.string.block_title, host),
        stringResource(R.string.block_body),
        stringResource(R.string.block_host, host),
        dismiss,
        confirm,
      )
  }
}

@Composable
private fun LibraryEntryMenu(
  entry: LibraryEntry,
  open: (LibraryEntry, Boolean, Boolean) -> Unit,
  share: (LibraryEntry) -> Unit,
  report: (LibraryEntry) -> Unit,
  confirm: (RowDialog) -> Unit,
) {
  var expanded by remember { mutableStateOf(false) }
  Column {
    val description = stringResource(R.string.more, entry.label)
    IconButton(
      onClick = { expanded = true },
      modifier = Modifier.semantics { contentDescription = description },
    ) {
      Text("⋮", Modifier.clearAndSetSemantics {})
    }
    DropdownMenu(expanded, onDismissRequest = { expanded = false }) {
      val item: @Composable (Int, String?, () -> Unit) -> Unit = { label, tag, action ->
        MenuItem(stringResource(label), tag, { expanded = false }, action)
      }
      item(R.string.share, null) { share(entry) }
      if (entry.isReceived) {
        item(R.string.report, "report-${entry.libraryId}") { report(entry) }
        item(R.string.hide, "hide-${entry.libraryId}") { confirm(RowDialog.Hide) }
        entry.sourceHost?.let { host ->
          MenuItem(
            stringResource(R.string.block_host, host),
            "block-${entry.libraryId}",
            { expanded = false },
          ) {
            confirm(RowDialog.Block)
          }
        }
      }
      item(R.string.delete, null) { confirm(RowDialog.Delete) }
      item(R.string.relaunch, null) { open(entry, false, true) }
      item(R.string.reset, null) { confirm(RowDialog.Reset) }
    }
  }
}

@Composable
private fun MenuItem(label: String, tag: String?, dismiss: () -> Unit, action: () -> Unit) {
  DropdownMenuItem(
    text = { Text(label) },
    modifier = tag?.let { Modifier.testTag(it) } ?: Modifier,
    onClick = {
      dismiss()
      action()
    },
  )
}

/** Report, Hide and Block for content another person sent (#16437). */
internal class ReceivedContentActions(
  val report: (LibraryEntry) -> Unit = {},
  val hide: (LibraryEntry) -> Unit = {},
  val block: (LibraryEntry) -> Unit = {},
)

@Composable
@Suppress("LongParameterList") // Dialog text, test tag and both outcomes are independent.
private fun ConfirmationDialog(
  tag: String,
  title: String,
  body: String,
  confirmLabel: String,
  dismiss: () -> Unit,
  confirm: () -> Unit,
) {
  AlertDialog(
    onDismissRequest = dismiss,
    title = { Text(title) },
    text = { Column(Modifier.verticalScroll(rememberScrollState())) { Text(body) } },
    confirmButton = {
      TextButton(modifier = Modifier.testTag(tag), onClick = confirm) { Text(confirmLabel) }
    },
    dismissButton = { TextButton(onClick = dismiss) { Text(stringResource(R.string.cancel)) } },
  )
}
