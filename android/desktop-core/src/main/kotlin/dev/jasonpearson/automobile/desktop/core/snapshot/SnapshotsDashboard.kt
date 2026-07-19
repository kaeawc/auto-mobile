package dev.jasonpearson.automobile.desktop.core.snapshot

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceSnapshotActions
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceSnapshotConfig
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceSnapshotConfigClient
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceSnapshotMetadata
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val LOG = LoggerFactory.getLogger("SnapshotsDashboard")

/**
 * Device snapshot archive: capture, restore, and the daemon's retention configuration.
 *
 * The two halves come from different transports on purpose. The snapshot list and the
 * capture/restore verbs are MCP tool/resource calls ([DeviceSnapshotActions]); the retention config
 * is the `device-snapshot.sock` config socket ([DeviceSnapshotConfigClient]), which supports only
 * `config/get` and `config/set`. Either half degrades on its own -- an older daemon without the
 * socket still lists and captures.
 */
@Composable
fun SnapshotsDashboard(
  actions: DeviceSnapshotActions?,
  configClient: DeviceSnapshotConfigClient?,
  activeDeviceId: String?,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  val scope = rememberCoroutineScope()

  var snapshots by remember { mutableStateOf<List<DeviceSnapshotMetadata>>(emptyList()) }
  var config by remember { mutableStateOf<DeviceSnapshotConfig?>(null) }
  var isLoading by remember { mutableStateOf(true) }
  var error by remember { mutableStateOf<String?>(null) }
  var busyMessage by remember { mutableStateOf<String?>(null) }
  var notice by remember { mutableStateOf<String?>(null) }
  var reloadToken by remember { mutableStateOf(0) }

  LaunchedEffect(actions, configClient, reloadToken) {
    isLoading = true
    error = null
    withContext(Dispatchers.IO) {
      snapshots =
        try {
          actions?.listSnapshots().orEmpty()
        } catch (e: Exception) {
          LOG.warn("Failed to list snapshots: ${e.message}", e)
          error = e.message ?: "Failed to list snapshots"
          emptyList()
        }

      // Retention config is optional: a daemon predating device-snapshot.sock still lists and
      // captures, so a failure here must not blank the dashboard.
      config =
        try {
          if (configClient?.isAvailable() == true) configClient.getConfig().config else null
        } catch (e: Exception) {
          LOG.warn("Snapshot config unavailable: ${e.message}", e)
          null
        }
    }
    isLoading = false
  }

  fun runAction(label: String, block: suspend () -> String?) {
    busyMessage = label
    notice = null
    error = null
    scope.launch {
      try {
        val message = withContext(Dispatchers.IO) { block() }
        notice = message
        reloadToken += 1
      } catch (e: Exception) {
        LOG.warn("$label failed: ${e.message}", e)
        error = e.message ?: "$label failed"
      } finally {
        busyMessage = null
      }
    }
  }

  Column(
    modifier = modifier.fillMaxSize().padding(12.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
        "Device Snapshots",
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        color = colors.text.normal,
      )

      Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        ActionChip(
          label = if (busyMessage != null) "Working…" else "Capture",
          accent = Color(0xFF4CAF50),
          enabled = actions != null && activeDeviceId != null && busyMessage == null,
        ) {
          val deviceId = activeDeviceId ?: return@ActionChip
          runAction("Capture") {
            val result = actions?.captureSnapshot(deviceId)
            val evicted = result?.evictedSnapshotNames.orEmpty()
            buildString {
              append("Captured '${result?.snapshotName}'")
              if (evicted.isNotEmpty()) {
                append(" — evicted ${evicted.size} older snapshot(s) to stay within the budget")
              }
            }
          }
        }
        ActionChip("Refresh", Color(0xFF2196F3), enabled = busyMessage == null) {
          reloadToken += 1
        }
      }
    }

    if (activeDeviceId == null) {
      Hint("Select a device to capture or restore snapshots.", colors.text.normal)
    }

    config?.let { current ->
      Text(
        "Archive budget ${current.maxArchiveSizeMb} MB · app data " +
          "${if (current.includeAppData) "on" else "off"} · settings " +
          "${if (current.includeSettings) "on" else "off"} · VM snapshot " +
          "${if (current.useVmSnapshot) "on" else "off"}",
        fontSize = 10.sp,
        color = colors.text.normal.copy(alpha = 0.6f),
      )
    }

    notice?.let { Hint(it, Color(0xFF4CAF50)) }
    error?.let { Hint(it, Color(0xFFE53935)) }

    when {
      isLoading -> Hint("Loading snapshots…", colors.text.normal)
      snapshots.isEmpty() ->
        Hint("No snapshots captured yet.", colors.text.normal.copy(alpha = 0.6f))
      else ->
        LazyColumn(
          modifier = Modifier.fillMaxSize(),
          verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
          items(snapshots) { snapshot ->
            SnapshotRow(
              snapshot = snapshot,
              canRestore = actions != null && activeDeviceId != null && busyMessage == null,
              onRestore = {
                val deviceId = activeDeviceId ?: return@SnapshotRow
                runAction("Restore") {
                  actions?.restoreSnapshot(deviceId, snapshot.snapshotName)
                  "Restored '${snapshot.snapshotName}'"
                }
              },
            )
          }
        }
    }
  }
}

@Composable
private fun SnapshotRow(
  snapshot: DeviceSnapshotMetadata,
  canRestore: Boolean,
  onRestore: () -> Unit,
) {
  val colors = SharedTheme.globalColors

  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(4.dp))
        .padding(horizontal = 10.dp, vertical = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Column(modifier = Modifier.weight(1f)) {
      Text(snapshot.snapshotName, fontSize = 11.sp, color = colors.text.normal)
      Text(
        listOfNotNull(
            snapshot.deviceName.takeIf { it.isNotBlank() },
            snapshot.snapshotType.takeIf { it.isNotBlank() },
            formatSize(snapshot.sizeBytes),
            snapshot.createdAt.takeIf { it.isNotBlank() },
          )
          .joinToString(" · "),
        fontSize = 9.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
      )
    }
    ActionChip("Restore", Color(0xFFFFA726), enabled = canRestore, onClick = onRestore)
  }
}

@Composable
private fun ActionChip(
  label: String,
  accent: Color,
  enabled: Boolean = true,
  onClick: () -> Unit,
) {
  val alpha = if (enabled) 1f else 0.4f
  Box(
    modifier =
      Modifier.background(accent.copy(alpha = 0.15f * alpha), RoundedCornerShape(4.dp))
        .let {
          if (enabled) it.clickable(onClick = onClick).pointerHoverIcon(PointerIcon.Hand) else it
        }
        .padding(horizontal = 8.dp, vertical = 3.dp)
  ) {
    Text(label, fontSize = 9.sp, softWrap = false, color = accent.copy(alpha = alpha))
  }
}

@Composable
private fun Hint(text: String, color: Color) {
  Text(text, fontSize = 10.sp, color = color.copy(alpha = 0.8f))
}

internal fun formatSize(bytes: Long): String =
  when {
    bytes <= 0 -> "unknown size"
    bytes >= 1_000_000_000 -> "${bytes / 1_000_000_000} GB"
    bytes >= 1_000_000 -> "${bytes / 1_000_000} MB"
    bytes >= 1_000 -> "${bytes / 1_000} KB"
    else -> "$bytes B"
  }
