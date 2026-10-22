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
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.content.IntentCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Every launch, including explicit intents, takes the same validated external-content route. */
class ImportActivity : ComponentActivity() {
  private var rejection by mutableStateOf<LibraryImportResult.Rejected?>(null)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      ProtoViewerTheme {
        Column(Modifier.windowInsetsPadding(WindowInsets.safeDrawing)) {
          Text(rejection?.let { "${it.path}: ${it.reason}" } ?: getString(R.string.loading))
          TextButton(onClick = { finish() }) { Text(getString(R.string.back)) }
        }
      }
    }
    if (savedInstanceState != null) {
      rejection = LibraryImportResult.Rejected("content", "Import interrupted; open the file again")
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
    val services = (application as ProtoViewerApplication).services
    lifecycleScope.launch {
      val result =
        withContext(services.io) {
          services.clearStaleExports()
          services.importer?.import(LibraryImportRequest(action, uri?.toString()))
        }
      when (result) {
        is LibraryImportResult.Imported -> {
          startActivity(Intent(this@ImportActivity, LibraryActivity::class.java))
          finish()
        }
        is LibraryImportResult.Rejected -> rejection = result
        null -> rejection = LibraryImportResult.Rejected("library", "Import unavailable")
      }
    }
  }
}
