package dev.jasonpearson.automobile.demos

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.design.system.components.AutoMobileTopAppBar
import dev.jasonpearson.automobile.prototype.PrototypeNetwork
import prototypes.EmbeddingSamplePrototype

/** Hosts the generated embedding sample, drawn in-app by the prototype renderer library. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EmbeddedPrototypeScreen(onNavigateBack: () -> Unit) {
  // Remembered so the runtime is not reloaded on recomposition (PrototypeNetwork has identity
  // semantics); the canned transport lets the sample's Load request succeed without a server.
  val network = remember { PrototypeNetwork(device = EmbeddedPrototypeDemoTransport) }
  var requestError by remember { mutableStateOf<String?>(null) }
  Scaffold(
    topBar = {
      AutoMobileTopAppBar(
        title = { Text(text = "Embedded Prototype") },
        navigationIcon = {
          IconButton(
            onClick = onNavigateBack,
            modifier = Modifier.semantics { testTag = "embedded_prototype_back" },
          ) {
            Icon(imageVector = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
          }
        },
        colors = TopAppBarDefaults.topAppBarColors(),
      )
    },
  ) { paddingValues ->
    Column(modifier = Modifier.fillMaxSize().padding(paddingValues)) {
      requestError?.let { message ->
        Text(
          text = message,
          color = MaterialTheme.colorScheme.error,
          modifier =
            Modifier.fillMaxWidth().padding(16.dp).semantics {
              testTag = "embedded_prototype_request_error"
            },
        )
      }
      EmbeddingSamplePrototype(
        modifier = Modifier.fillMaxSize(),
        network = network,
        onEvent = { event ->
          EmbeddedPrototypeRequestStatus.messageFor(event)?.let {
            requestError = it.ifEmpty { null }
          }
        },
      )
    }
  }
}
