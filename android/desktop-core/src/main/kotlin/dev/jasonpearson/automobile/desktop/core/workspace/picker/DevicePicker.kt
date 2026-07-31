package dev.jasonpearson.automobile.desktop.core.workspace.picker

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.workspace.Platform

private val Accent = Color(0xFF4DABF7)

/**
 * Full-screen device picker. Stateless over [DevicePickerUiState] with hoisted [onAction]; the
 * workspace hosts it and turns the Observe effect into columns.
 */
@Composable
fun DevicePicker(
  state: DevicePickerUiState,
  onAction: (DevicePickerAction) -> Unit,
  onClose: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Column(modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
    when (state) {
      is DevicePickerUiState.Loading -> Centered("Loading devices…")
      is DevicePickerUiState.Error ->
        Centered("Couldn't load devices: ${state.message}") {
          Button(onClick = { onAction(DevicePickerAction.Refresh) }) { Text("Retry") }
        }
      is DevicePickerUiState.Content -> Content(state, onAction, onClose)
    }
  }
}

@Composable
private fun Centered(message: String, extra: @Composable (() -> Unit)? = null) {
  Column(
    Modifier.fillMaxSize(),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (extra != null) {
      Spacer(Modifier.height(12.dp))
      extra()
    }
  }
}

@Composable
private fun Content(
  content: DevicePickerUiState.Content,
  onAction: (DevicePickerAction) -> Unit,
  onClose: () -> Unit,
) {
  Row(Modifier.fillMaxSize()) {
    FilterRail(content, onAction)
    Column(Modifier.weight(1f).fillMaxHeight()) {
      HeaderRow(content, onAction, onClose)
      ActiveChips(content.filters, onAction)
      DeviceGrid(content, onAction)
    }
  }
}

@Composable
private fun FilterRail(
  content: DevicePickerUiState.Content,
  onAction: (DevicePickerAction) -> Unit,
) {
  Column(
    Modifier.width(240.dp)
      .fillMaxHeight()
      .background(MaterialTheme.colorScheme.surfaceVariant)
      .padding(12.dp)
  ) {
    OutlinedTextField(
      value = content.filters.query,
      onValueChange = { onAction(DevicePickerAction.SetQuery(it)) },
      label = { Text("Filter") },
      singleLine = true,
      modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Filter search" },
    )
    Spacer(Modifier.height(8.dp))
    LazyColumn(Modifier.fillMaxSize()) {
      for (dimension in FilterDimension.entries) {
        val opts = options(content.devices, content.filters, dimension)
        if (opts.isEmpty()) continue
        item(key = "hdr-${dimension.name}") {
          Text(
            dimension.title.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 10.dp, bottom = 4.dp),
          )
        }
        items(opts, key = { "${dimension.name}-${it.value}" }) { opt ->
          OptionRow(opt) { toggle(dimension, opt.value, onAction) }
        }
      }
    }
  }
}

@Composable
private fun OptionRow(opt: FilterOption, onClick: () -> Unit) {
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .clickable(onClick = onClick)
        .semantics {
          contentDescription = "${if (opt.selected) "Deselect" else "Select"} filter ${opt.label}"
        }
        .padding(vertical = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      Modifier.width(16.dp)
        .height(16.dp)
        .background(
          if (opt.selected) Accent else MaterialTheme.colorScheme.surface,
          RoundedCornerShape(3.dp),
        )
    ) {
      if (opt.selected) Text("✓", color = Color.White, style = MaterialTheme.typography.labelSmall)
    }
    Spacer(Modifier.width(8.dp))
    Text(opt.label, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
    Text(opt.count.toString(), color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}

@Composable
private fun ActiveChips(filters: PickerFilters, onAction: (DevicePickerAction) -> Unit) {
  val chips = buildList {
    filters.states.forEach { add(it.label() to { onAction(DevicePickerAction.ToggleState(it)) }) }
    filters.platforms.forEach {
      add(it.label() to { onAction(DevicePickerAction.TogglePlatform(it)) })
    }
    filters.osKeys.forEach { add(it to { onAction(DevicePickerAction.ToggleOs(it)) }) }
    filters.architectures.forEach { add(it to { onAction(DevicePickerAction.ToggleArch(it)) }) }
  }
  if (chips.isEmpty()) return
  Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
    chips.forEach { (label, remove) ->
      Row(
        modifier =
          Modifier.padding(end = 8.dp)
            .clickable(onClick = remove)
            .semantics { contentDescription = "Remove filter $label" }
            .background(Accent, RoundedCornerShape(4.dp))
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(label, color = Color.White)
        Text("  ✕", color = Color.White)
      }
    }
  }
}

@Composable
private fun HeaderRow(
  content: DevicePickerUiState.Content,
  onAction: (DevicePickerAction) -> Unit,
  onClose: () -> Unit,
) {
  val count = content.selectedIds.size
  Row(
    modifier = Modifier.fillMaxWidth().padding(16.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      "Choose devices to observe",
      style = MaterialTheme.typography.titleMedium,
      fontWeight = FontWeight.SemiBold,
    )
    Spacer(Modifier.weight(1f))
    Button(
      onClick = { onAction(DevicePickerAction.ObserveSelected) },
      enabled = count > 0,
      modifier = Modifier.semantics { contentDescription = "Observe selected" },
    ) {
      Text(if (count > 0) "Observe ($count)" else "Observe")
    }
    Spacer(Modifier.width(8.dp))
    Text(
      "Close",
      color = Accent,
      modifier =
        Modifier.clickable(onClick = onClose).semantics { contentDescription = "Close picker" },
    )
  }
}

@Composable
private fun DeviceGrid(
  content: DevicePickerUiState.Content,
  onAction: (DevicePickerAction) -> Unit,
) {
  val devices = filteredDevices(content.devices, content.filters)
  LazyVerticalGrid(
    columns = GridCells.Adaptive(220.dp),
    modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    items(devices, key = { it.id }) { device ->
      DeviceCard(
        device = device,
        selected = device.id in content.selectedIds,
        booting = device.id in content.bootingIds,
        error = content.bootErrors[device.id],
        onClick = {
          if (device.state == DeviceState.Booted) {
            onAction(DevicePickerAction.ToggleSelect(device.id))
          } else {
            onAction(DevicePickerAction.BootDevice(device.id))
          }
        },
      )
    }
  }
}

@Composable
private fun DeviceCard(
  device: PickerDevice,
  selected: Boolean,
  booting: Boolean,
  error: String?,
  onClick: () -> Unit,
) {
  val booted = device.state == DeviceState.Booted
  // A shut-down card boots on click (unless a boot is already in flight); a booted card selects.
  val clickable = booted || !booting
  Column(
    modifier =
      Modifier.fillMaxWidth()
        .border(
          width = if (selected) 2.dp else 1.dp,
          color = if (selected) Accent else MaterialTheme.colorScheme.outlineVariant,
          shape = RoundedCornerShape(6.dp),
        )
        .then(if (clickable) Modifier.clickable(onClick = onClick) else Modifier)
        .semantics { contentDescription = cardDescription(device, booted, booting, error) }
        .padding(12.dp)
  ) {
    Text("${device.platform.emoji}  ${device.name}", style = MaterialTheme.typography.bodyLarge)
    Spacer(Modifier.height(4.dp))
    val meta =
      listOfNotNull(
          if (device.platform == Platform.Ios) "iOS" else "Android",
          device.osLabel,
          device.architecture,
          if (booted) "booted" else "Shut down",
        )
        .joinToString(" · ")
    Text(
      meta,
      style = MaterialTheme.typography.bodySmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    if (!booted) {
      Text(
        bootAffordance(booting, error),
        style = MaterialTheme.typography.labelSmall,
        color = if (error != null) MaterialTheme.colorScheme.error else Accent,
      )
    }
  }
}

private fun cardDescription(
  device: PickerDevice,
  booted: Boolean,
  booting: Boolean,
  error: String?,
): String =
  when {
    booted -> "Select ${device.name}"
    booting -> "Booting ${device.name}"
    error != null -> "Retry boot ${device.name}"
    else -> "Boot ${device.name}"
  }

private fun bootAffordance(booting: Boolean, error: String?): String =
  when {
    booting -> "Booting…"
    error != null -> "Boot failed · Click to retry"
    else -> "Click to boot"
  }

private fun toggle(
  dimension: FilterDimension,
  value: String,
  onAction: (DevicePickerAction) -> Unit,
) {
  when (dimension) {
    FilterDimension.State -> onAction(DevicePickerAction.ToggleState(DeviceState.valueOf(value)))
    FilterDimension.Platform -> onAction(DevicePickerAction.TogglePlatform(Platform.valueOf(value)))
    FilterDimension.OsVersion -> onAction(DevicePickerAction.ToggleOs(value))
    FilterDimension.Architecture -> onAction(DevicePickerAction.ToggleArch(value))
  }
}
