package dev.jasonpearson.automobile.discover

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentButton
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentCard
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentElevatedButton
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentOutlinedButton
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentTextButton
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentTonalButton
import dev.jasonpearson.automobile.design.system.components.AutoMobileFilterChip
import dev.jasonpearson.automobile.design.system.components.AutoMobileIconButton

@Composable
internal fun TapButtons(trackTap: () -> Unit) {
  // Button varieties
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth().semantics { testTag = "buttons_card" },
    elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
  ) {
    Column(modifier = Modifier.padding(16.dp)) {
      Text(
        text = "Buttons",
        fontSize = 18.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(bottom = 8.dp).semantics { testTag = "buttons_section_title" },
      )

      TapButtonRows(trackTap)

      AutoMobileContentTonalButton(
        onClick = trackTap,
        modifier =
          Modifier.fillMaxWidth().semantics {
            testTag = "button_filled_tonal"
            contentDescription = "Filled Tonal Button"
          },
      ) {
        Text("Filled Tonal Button")
      }
    }
  }
}

@Composable
internal fun TapToggles(state: TapControlsState, trackTap: () -> Unit) {
  // Toggle controls
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth().semantics { testTag = "toggle_controls_card" },
    elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
  ) {
    Column(modifier = Modifier.padding(16.dp)) {
      Text(
        text = "Toggle Controls",
        fontSize = 18.sp,
        fontWeight = FontWeight.Bold,
        modifier =
          Modifier.padding(bottom = 8.dp).semantics {
            testTag = "toggle_controls_section_title"
          },
      )

      TapSwitch(state, trackTap)

      TapCheckbox(state, trackTap)

      TapRadioButton(state, trackTap)
    }
  }
}

@Composable
internal fun TapIconButtons(trackTap: () -> Unit) {
  // Icon buttons
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth().semantics { testTag = "icon_buttons_card" },
    elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
  ) {
    Column(modifier = Modifier.padding(16.dp)) {
      Text(
        text = "Icon Buttons",
        fontSize = 18.sp,
        fontWeight = FontWeight.Bold,
        modifier =
          Modifier.padding(bottom = 8.dp).semantics {
            testTag = "icon_buttons_section_title"
          },
      )

      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
        TapIconButton(Icons.Filled.Edit, "Edit", "icon_button_edit", trackTap)

        TapIconButton(Icons.Filled.Delete, "Delete", "icon_button_delete", trackTap)

        TapIconButton(Icons.Filled.Favorite, "Favorite", "icon_button_favorite", trackTap)

        TapIconButton(Icons.Filled.Star, "Star", "icon_button_star", trackTap)

        TapIconButton(Icons.Filled.Refresh, "Refresh", "icon_button_refresh", trackTap)
      }
    }
  }
}

@Composable
internal fun TapChips(state: TapControlsState, trackTap: () -> Unit) {
  // Chips
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth().semantics { testTag = "filter_chips_card" },
    elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
  ) {
    Column(modifier = Modifier.padding(16.dp)) {
      Text(
        text = "Filter Chips",
        fontSize = 18.sp,
        fontWeight = FontWeight.Bold,
        modifier =
          Modifier.padding(bottom = 8.dp).semantics {
            testTag = "filter_chips_section_title"
          },
      )

      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        TapFilterChip(1, state.chip1Selected) {
          state.chip1Selected = !state.chip1Selected
          trackTap()
        }

        TapFilterChip(2, state.chip2Selected) {
          state.chip2Selected = !state.chip2Selected
          trackTap()
        }

        TapFilterChip(3, state.chip3Selected) {
          state.chip3Selected = !state.chip3Selected
          trackTap()
        }
      }
    }
  }
}

@Composable
private fun TapButtonRows(trackTap: () -> Unit) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    AutoMobileContentButton(
      onClick = trackTap,
      modifier =
        Modifier.weight(1f).semantics {
          testTag = "button_regular"
          contentDescription = "Regular Button"
        },
    ) {
      Text("Button")
    }

    AutoMobileContentElevatedButton(
      onClick = trackTap,
      modifier =
        Modifier.weight(1f).semantics {
          testTag = "button_elevated"
          contentDescription = "Elevated Button"
        },
    ) {
      Text("Elevated")
    }
  }

  Spacer(modifier = Modifier.height(8.dp))

  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    AutoMobileContentOutlinedButton(
      onClick = trackTap,
      modifier =
        Modifier.weight(1f).semantics {
          testTag = "button_outlined"
          contentDescription = "Outlined Button"
        },
    ) {
      Text("Outlined")
    }

    AutoMobileContentTextButton(
      onClick = trackTap,
      modifier =
        Modifier.weight(1f).semantics {
          testTag = "button_text"
          contentDescription = "Text Button"
        },
    ) {
      Text("Text")
    }
  }

  Spacer(modifier = Modifier.height(8.dp))
}

@Composable
private fun TapSwitch(state: TapControlsState, trackTap: () -> Unit) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Switch(
      checked = state.switchChecked,
      onCheckedChange = {
        state.switchChecked = it
        trackTap()
      },
      modifier =
        Modifier.semantics {
          testTag = "switch_control"
          contentDescription = if (state.switchChecked) "Switch is on" else "Switch is off"
          stateDescription = if (state.switchChecked) "Enabled" else "Disabled"
        },
    )
    Text("Switch", modifier = Modifier.semantics { testTag = "switch_label" })
  }
}

@Composable
private fun TapCheckbox(state: TapControlsState, trackTap: () -> Unit) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Checkbox(
      checked = state.checkboxChecked,
      onCheckedChange = {
        state.checkboxChecked = it
        trackTap()
      },
      modifier =
        Modifier.semantics {
          testTag = "checkbox_control"
          contentDescription =
            if (state.checkboxChecked) "Checkbox is checked" else "Checkbox is unchecked"
          stateDescription = if (state.checkboxChecked) "Checked" else "Unchecked"
        },
    )
    Text("Checkbox", modifier = Modifier.semantics { testTag = "checkbox_label" })
  }
}

@Composable
private fun TapRadioButton(state: TapControlsState, trackTap: () -> Unit) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    RadioButton(
      selected = state.radioSelected,
      onClick = {
        state.radioSelected = !state.radioSelected
        trackTap()
      },
      modifier =
        Modifier.semantics {
          testTag = "radio_button_control"
          contentDescription =
            if (state.radioSelected) "Radio button is selected" else "Radio button is not selected"
          stateDescription = if (state.radioSelected) "Selected" else "Not selected"
        },
    )
    Text("Radio Button", modifier = Modifier.semantics { testTag = "radio_button_label" })
  }
}

@Composable
private fun TapIconButton(icon: ImageVector, label: String, tag: String, onClick: () -> Unit) {
  AutoMobileIconButton(
    onClick = onClick,
    modifier =
      Modifier.semantics {
        testTag = tag
        contentDescription = label
      },
  ) {
    Icon(icon, contentDescription = label)
  }
}

@Composable
private fun TapFilterChip(index: Int, selected: Boolean, onClick: () -> Unit) {
  AutoMobileFilterChip(
    selected = selected,
    onClick = onClick,
    label = { Text("Chip $index") },
    modifier =
      Modifier.semantics {
        testTag = "filter_chip_$index"
        contentDescription =
          if (selected) "Chip $index is selected" else "Chip $index is not selected"
        stateDescription = if (selected) "Selected" else "Not selected"
      },
  )
}
