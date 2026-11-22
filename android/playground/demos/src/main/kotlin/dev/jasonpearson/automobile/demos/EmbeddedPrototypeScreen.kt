package dev.jasonpearson.automobile.demos

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import dev.jasonpearson.automobile.design.system.components.AutoMobileTopAppBar
import prototypes.EmbeddingSamplePrototype

/** Hosts the generated embedding sample, drawn in-app by the prototype renderer library. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EmbeddedPrototypeScreen(onNavigateBack: () -> Unit) {
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
    EmbeddingSamplePrototype(modifier = Modifier.fillMaxSize().padding(paddingValues))
  }
}
