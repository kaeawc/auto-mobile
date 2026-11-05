package dev.jasonpearson.automobile.protoviewer

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.core.content.IntentCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Every launch, including explicit intents, takes the same validated external-content route. */
class ImportActivity : ComponentActivity() {
  private var rejection by mutableStateOf<LibraryImportResult.Rejected?>(null)
  private var pendingShare by mutableStateOf<ShareImportLink?>(null)
  private var shareFailure by mutableStateOf<Int?>(null)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      ProtoViewerTheme {
        val share = pendingShare
        if (share != null) {
          ShareImportConfirmation(share, ::confirmShare) { finish() }
        } else {
          ImportStatus(importStatusText(shareFailure, rejection)) { finish() }
        }
      }
    }
    if (savedInstanceState != null) {
      rejection = LibraryImportResult.Rejected("content", getString(R.string.import_interrupted))
      return
    }
    val action =
      when (intent.action) {
        Intent.ACTION_VIEW -> ImportAction.View
        Intent.ACTION_SEND -> ImportAction.Send
        else -> null
      }
    val uri =
      if (action == ImportAction.Send)
        IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
      else intent.data
    if (uri?.scheme.equals("automobile-proto", ignoreCase = true)) {
      pendingShare =
        if (action == ImportAction.View) ShareImportLink.parse(uri.toString()) else null
      if (pendingShare == null) shareFailure = R.string.share_import_invalid
      return
    }
    val services = (application as ProtoViewerApplication).services
    lifecycleScope.launch {
      val result =
        withContext(services.io) {
          services.clearStaleExports()
          services.importer?.import(LibraryImportRequest(action, uri?.toString()))
        }
      complete(result)
    }
  }

  private fun confirmShare() {
    val link = pendingShare ?: return
    // Remove the confirmation immediately, so a second tap cannot start another download.
    pendingShare = null
    val services = (application as ProtoViewerApplication).services
    lifecycleScope.launch {
      val result = withContext(services.io) { services.shareImporter?.importConfirmed(link) }
      when (result) {
        is ShareImportResult.Completed -> complete(result.result)
        is ShareImportResult.Failed ->
          shareFailure =
            when (result.error) {
              ShareImportError.Blocked -> R.string.share_import_blocked
              ShareImportError.Download -> R.string.share_import_download_failed
              ShareImportError.TooLarge -> R.string.share_import_too_large
              ShareImportError.HashMismatch -> R.string.share_import_hash_mismatch
            }
        null -> shareFailure = R.string.import_unavailable
      }
    }
  }

  private fun complete(result: LibraryImportResult?) {
    when (result) {
      is LibraryImportResult.Imported -> {
        startActivity(Intent(this, LibraryActivity::class.java))
        finish()
      }
      is LibraryImportResult.Rejected -> rejection = result
      null ->
        rejection = LibraryImportResult.Rejected("library", getString(R.string.import_unavailable))
    }
  }
}

@Composable
internal fun ShareImportConfirmation(
  link: ShareImportLink,
  confirm: () -> Unit,
  cancel: () -> Unit,
) {
  Column(
    Modifier.windowInsetsPadding(WindowInsets.safeDrawing).verticalScroll(rememberScrollState()),
  ) {
    Text(stringResource(R.string.share_import_title))
    Text(stringResource(R.string.share_import_host, link.url.host))
    Text(stringResource(R.string.share_import_hash, link.sha256))
    TextButton(onClick = confirm) { Text(stringResource(R.string.share_import_confirm)) }
    TextButton(onClick = cancel) { Text(stringResource(R.string.cancel)) }
  }
}

@Composable
private fun importStatusText(shareFailure: Int?, failed: LibraryImportResult.Rejected?): String =
  when {
    shareFailure != null -> stringResource(shareFailure)
    failed != null && failed.isHidden -> stringResource(R.string.import_hidden)
    failed != null -> stringResource(R.string.import_rejected, failed.path, failed.reason)
    else -> stringResource(R.string.loading)
  }

/** The library refused content the user hid or blocked; it is never stored. */
internal val LibraryImportResult.Rejected.isHidden: Boolean
  get() = path == "library" && reason == LibraryError.Hidden.name

@Composable
internal fun ImportStatus(text: String, back: () -> Unit) {
  Column(
    Modifier.windowInsetsPadding(WindowInsets.safeDrawing).verticalScroll(rememberScrollState()),
  ) {
    Text(text)
    TextButton(onClick = back) { Text(stringResource(R.string.back)) }
  }
}
