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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Lists every bundled runtime dependency with its license text, from the generated notices. */
class LicensesActivity : ComponentActivity() {
  private var document by mutableStateOf<LicenseDocument?>(null)
  private var failed by mutableStateOf(false)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent { ProtoViewerTheme { LicensesScreen(document, failed) } }
    val services = (application as ProtoViewerApplication).services
    lifecycleScope.launch {
      val loaded =
        withContext(services.io) {
          loadLicenseDocument { resources.openRawResource(R.raw.aboutlibraries) }
        }
      document = loaded
      failed = loaded == null
    }
  }
}

@Composable
internal fun LicensesScreen(document: LicenseDocument?, failed: Boolean) {
  Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(16.dp)) {
    Text(stringResource(R.string.open_source_licenses), Modifier.semantics { heading() })
    when {
      failed -> Text(stringResource(R.string.licenses_error))
      document == null -> Text(stringResource(R.string.loading))
      else -> {
        val libraries =
          remember(document) { document.libraries.sortedBy { it.displayName.lowercase() } }
        LazyColumn {
          items(libraries, key = { it.uniqueId }) { library -> LicenseRow(library, document) }
        }
      }
    }
  }
}

@Composable
private fun LicenseRow(library: LicensedLibrary, document: LicenseDocument) {
  var expanded by remember { mutableStateOf(false) }
  val licenses = library.licenses.mapNotNull { document.licenses[it] }
  Column {
    ListItem(
      headlineContent = { Text(library.displayName) },
      supportingContent = {
        Text(
          listOfNotNull(
              library.artifactVersion,
              library.owner,
              licenses.firstNotNullOfOrNull { it.name },
            )
            .joinToString(" · "),
        )
      },
      modifier =
        Modifier.fillMaxWidth().testTag("license-${library.uniqueId}").clickable(
          role = Role.Button,
        ) {
          expanded = !expanded
        },
    )
    if (expanded)
      licenses.forEach { license ->
        Text(license.content.orEmpty(), Modifier.testTag("license-text-${library.uniqueId}"))
      }
  }
}
