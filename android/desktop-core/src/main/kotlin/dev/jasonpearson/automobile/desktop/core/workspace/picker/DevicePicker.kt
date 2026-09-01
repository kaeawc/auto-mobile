@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.staggeredgrid.LazyVerticalStaggeredGrid
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridCells
import androidx.compose.foundation.lazy.staggeredgrid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.isCtrlPressed
import androidx.compose.ui.input.pointer.isMetaPressed
import androidx.compose.ui.input.pointer.isShiftPressed
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrapState
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonLifecyclePhase
import dev.jasonpearson.automobile.desktop.core.theme.PlatformIcons
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
  // Whether the "Close" affordance is offered. False when the grid is the app's home surface (no
  // observed workspace to return to); true when opened over an existing workspace ("Devices +").
  canClose: Boolean = true,
  // Install/start progress of the shared daemon. The picker's first load can silently install Bun
  // and start the daemon (up to the daemon-startup budget), so the Loading state narrates that
  // work instead of sitting on "Loading devices…", and the Error state surfaces the bootstrap
  // failure with its actionable message.
  bootstrapState: DaemonBootstrapState = DaemonBootstrapState.Inactive,
  // The per-card device thumbnail. Hoisted (default = the screenshot [DeviceThumbnail]) so a test
  // can stub it and never open an observation socket while composing the grid. Thumbnails are
  // stills by design — a per-card live-video subscription would put a standing capture/decode cost
  // on every booted tile of a potentially huge grid.
  thumbnail: @Composable (device: PickerDevice, booting: Boolean) -> Unit = { device, booting ->
    // Width-only sizing: the thumbnail derives its own height from the device's aspect ratio
    // (screenshot ratio once captured, a portrait stand-in until then), which the staggered grid
    // below packs masonry-style.
    DeviceThumbnail(
      device = device,
      booting = booting,
      modifier = Modifier.fillMaxWidth(),
    )
  },
) {
  Column(modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
    when (state) {
      is DevicePickerUiState.Loading -> Centered(loadingMessage(bootstrapState))
      is DevicePickerUiState.Error -> {
        val bootstrapFailure = (bootstrapState as? DaemonBootstrapState.Failed)?.message
        Centered(
          message =
            if (bootstrapFailure != null) "AutoMobile daemon isn't available"
            else "Couldn't load devices",
          detail = bootstrapFailure ?: state.message,
        ) {
          // Retry re-runs the whole chain: the load's preflight re-detects the daemon and, when
          // none is reachable, re-attempts the install/start pipeline before reading devices.
          Button(onClick = { onAction(DevicePickerAction.Refresh) }) { Text("Retry") }
        }
      }
      is DevicePickerUiState.Content -> Content(state, onAction, onClose, canClose, thumbnail)
    }
  }
}

/**
 * Maps the daemon-bootstrap phase behind a Loading state to what the user is actually waiting on. A
 * first launch on a machine without AutoMobile can spend most of a minute installing Bun and
 * fetching the daemon package; that must read as setup progress, not a hung device list.
 */
internal fun loadingMessage(bootstrap: DaemonBootstrapState): String =
  when (bootstrap) {
    is DaemonBootstrapState.Working ->
      when (val phase = bootstrap.phase) {
        DaemonLifecyclePhase.InstallingRuntime -> "Installing the Bun runtime (one-time setup)…"
        is DaemonLifecyclePhase.LaunchingDaemon ->
          if (phase.action == "restart") "Updating the AutoMobile daemon to ${phase.version}…"
          else "Starting AutoMobile ${phase.version}…"
        DaemonLifecyclePhase.Verifying -> "Waiting for the AutoMobile daemon…"
        else -> "Loading devices…"
      }
    else -> "Loading devices…"
  }

@Composable
private fun Centered(
  message: String,
  detail: String? = null,
  extra: @Composable (() -> Unit)? = null,
) {
  Column(
    Modifier.fillMaxSize().padding(horizontal = 48.dp),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (detail != null) {
      Spacer(Modifier.height(8.dp))
      Text(
        detail,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodySmall,
      )
    }
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
  canClose: Boolean,
  thumbnail: @Composable (PickerDevice, Boolean) -> Unit,
) {
  Row(Modifier.fillMaxSize()) {
    FilterRail(content, onAction)
    Column(Modifier.weight(1f).fillMaxHeight()) {
      HeaderRow(content, onAction, onClose, canClose)
      ActiveChips(content.filters, onAction)
      DeviceGrid(content, onAction, thumbnail)
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
  canClose: Boolean,
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
    // Multi-select path: the button appears only once a Cmd/Shift-click selection exists; a plain
    // click observes a single device immediately without touching this button.
    if (count > 0) {
      Button(
        onClick = { onAction(DevicePickerAction.ObserveSelected) },
        modifier = Modifier.semantics { contentDescription = "Observe selected" },
      ) {
        Text("Observe ($count)")
      }
      Spacer(Modifier.width(8.dp))
    }
    // Close is hidden when the grid is the home surface (nothing observed to return to).
    if (canClose) {
      Text(
        "Close",
        color = Accent,
        modifier =
          Modifier.clickable(onClick = onClose).semantics { contentDescription = "Close picker" },
      )
    }
  }
}

@Composable
private fun DeviceGrid(
  content: DevicePickerUiState.Content,
  onAction: (DevicePickerAction) -> Unit,
  thumbnail: @Composable (PickerDevice, Boolean) -> Unit,
) {
  val devices = filteredDevices(content.devices, content.filters)
  // Masonry (Pinterest-style) packing: every card is column-width, but each card's HEIGHT follows
  // its own device's aspect ratio, so the staggered grid packs disjoint heights instead of forcing
  // one uniform row height.
  LazyVerticalStaggeredGrid(
    columns = StaggeredGridCells.Adaptive(220.dp),
    modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalItemSpacing = 12.dp,
  ) {
    items(devices, key = { it.id }) { device ->
      DeviceCard(
        device = device,
        selected = device.id in content.selectedIds,
        booting = device.id in content.bootingIds,
        error = content.bootErrors[device.id],
        thumbnail = thumbnail,
        onClick = { multiSelect ->
          when {
            // A shut-down card boots on click; the boot auto-observes once it completes.
            device.state != DeviceState.Booted -> onAction(DevicePickerAction.BootDevice(device.id))
            // Cmd/Shift-click builds a multi-device selection to observe together.
            multiSelect -> onAction(DevicePickerAction.ToggleSelect(device.id))
            // Plain click observes this device immediately.
            else -> onAction(DevicePickerAction.ObserveOne(device.id))
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
  thumbnail: @Composable (PickerDevice, Boolean) -> Unit,
  onClick: (multiSelect: Boolean) -> Unit,
) {
  val booted = device.state == DeviceState.Booted
  // A shut-down card boots on click (unless a boot is already in flight); a booted card observes.
  val clickable = booted || !booting
  val windowInfo = LocalWindowInfo.current
  val isIos = device.platform == Platform.Ios
  Column(
    modifier =
      Modifier.fillMaxWidth()
        .border(
          width = if (selected) 2.dp else 1.dp,
          color = if (selected) Accent else MaterialTheme.colorScheme.outlineVariant,
          shape = RoundedCornerShape(6.dp),
        )
        .then(
          if (clickable)
            Modifier.clickable {
              // Read the live modifier state at click time (mirrors the repo's Meta/Ctrl handling):
              // Shift or Cmd/Ctrl means "add to selection" rather than "observe now".
              val mods = windowInfo.keyboardModifiers
              onClick(mods.isShiftPressed || mods.isMetaPressed || mods.isCtrlPressed)
            }
          else Modifier
        )
        .semantics { contentDescription = cardDescription(device, booted, booting, error) }
        .padding(12.dp)
  ) {
    thumbnail(device, booting)
    Spacer(Modifier.height(8.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
      Icon(
        imageVector = PlatformIcons.logo(isIos),
        contentDescription = null,
        tint = PlatformIcons.tint(isIos),
        modifier = Modifier.size(16.dp),
      )
      Spacer(Modifier.width(6.dp))
      Text(device.name, style = MaterialTheme.typography.bodyLarge)
    }
    Spacer(Modifier.height(4.dp))
    val meta =
      listOfNotNull(
          if (isIos) "iOS" else "Android",
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
    booted -> "Observe ${device.name}"
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
