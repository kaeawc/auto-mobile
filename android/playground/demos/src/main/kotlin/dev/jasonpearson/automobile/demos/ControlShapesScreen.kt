package dev.jasonpearson.automobile.demos

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.design.system.components.AutoMobileTopAppBar
import dev.jasonpearson.automobile.sdk.TrackRecomposition

/** Labels of the flat Text/Switch siblings, in order; each label sits before its own switch. */
val FLAT_SIBLING_LABELS = listOf("Flat Wi-Fi", "Flat Bluetooth")

/** Labels of the switches that all share one test tag, in order. */
val DUPLICATE_ID_LABELS = listOf("Duplicate A", "Duplicate B", "Duplicate C")

/** Test tag (resource id) shared by every duplicate-id switch. */
const val DUPLICATE_ID_SWITCH_TAG = "duplicate_id_switch"

/** Test tag of the slider that shows no value readout. */
const val READOUT_LESS_SLIDER_TAG = "readout_less_slider"

/**
 * Three control shapes that the other demos do not have: flat `Text, Switch, Text, Switch` siblings
 * in one container, several switches sharing one resource id, and a slider with no visible readout.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ControlShapesScreen(onNavigateBack: () -> Unit) {
  TrackRecomposition(id = "screen.demo.controls.shapes", composableName = "ControlShapesScreen") {
    Scaffold(
      topBar = {
        AutoMobileTopAppBar(
          title = { Text(text = "Control Shapes") },
          navigationIcon = {
            IconButton(
              onClick = onNavigateBack,
              modifier = Modifier.semantics { testTag = "control_shapes_back" },
            ) {
              Icon(
                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "Back",
              )
            }
          },
        )
      }
    ) { paddingValues ->
      Column(
        modifier =
          Modifier.fillMaxSize().padding(paddingValues).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(16.dp),
      ) {
        FlatSiblingSwitches()
        DuplicateIdSwitches()
        ReadoutLessSlider()
      }
    }
  }
}

@Composable
private fun FlatSiblingSwitches() {
  Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
    Text(text = "Flat siblings", style = MaterialTheme.typography.titleMedium)
    FLAT_SIBLING_LABELS.forEach { label ->
      var checked by rememberSaveable(label) { mutableStateOf(false) }
      Text(text = label)
      Switch(checked = checked, onCheckedChange = { checked = it })
    }
  }
}

@Composable
private fun DuplicateIdSwitches() {
  Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
    Text(text = "Duplicate ids", style = MaterialTheme.typography.titleMedium)
    DUPLICATE_ID_LABELS.forEach { label ->
      var checked by rememberSaveable(label) { mutableStateOf(false) }
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(text = label)
        Switch(
          checked = checked,
          onCheckedChange = { checked = it },
          modifier = Modifier.semantics { testTag = DUPLICATE_ID_SWITCH_TAG },
        )
      }
    }
  }
}

@Composable
private fun ReadoutLessSlider() {
  var value by rememberSaveable { mutableFloatStateOf(0.5f) }
  Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
    Text(text = "Readout-less slider", style = MaterialTheme.typography.titleMedium)
    Slider(
      value = value,
      onValueChange = { value = it },
      steps = 9,
      modifier = Modifier.semantics { testTag = READOUT_LESS_SLIDER_TAG },
    )
  }
}
