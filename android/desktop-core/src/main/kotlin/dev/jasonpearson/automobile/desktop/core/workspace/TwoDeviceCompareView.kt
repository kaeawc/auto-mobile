package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.background
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.layout.HierarchyDiff
import dev.jasonpearson.automobile.desktop.core.layout.HierarchyDiffEntry
import dev.jasonpearson.automobile.desktop.core.layout.LayoutInspectorDashboard
import dev.jasonpearson.automobile.desktop.core.layout.NodeDiffStatus
import dev.jasonpearson.automobile.desktop.core.layout.ParsedHierarchy
import dev.jasonpearson.automobile.desktop.core.layout.diffHierarchies
import dev.jasonpearson.automobile.desktop.core.layout.parseHierarchyFromJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private val OnlyInAColor = Color(0xFF4CAF50) // green: present on the left device only
private val OnlyInBColor = Color(0xFF4DABF7) // blue: present on the right device only
private val ChangedColor = Color(0xFFFFC107) // amber: same position, differing attribute

private const val DIFF_STRIP_HEIGHT_DP = 140

/**
 * First-cut two-device compare surface: the [columnA] and [columnB] Layout inspectors side by side
 * (each with its own per-device observation stream, so panes never bleed into each other) over a
 * [HierarchyDiffStrip] that classifies nodes present/absent/changed between the two devices' view
 * hierarchies via the pure [diffHierarchies].
 *
 * Both the per-side stream and the per-side dashboard body are injected:
 * - [observationStreamFactory] hands out a fresh [ObservationStream] per pane (defaulting to a real
 *   per-device [ObservationStreamClient]), mirroring [LayoutFacet], so tests drive it with a
 *   `FakeObservationStream`.
 * - [sideContent] renders a pane's mirror + hierarchy (defaulting to [LayoutInspectorDashboard]); a
 *   test can swap in a lightweight body so the diff strip can be asserted without the full
 *   inspector.
 *
 * The diff itself is computed here from each stream's parsed hierarchy, independently of
 * [sideContent], so it surfaces even when the side bodies are stubbed.
 */
@Composable
fun TwoDeviceCompareView(
  columnA: DeviceColumn,
  columnB: DeviceColumn,
  modifier: Modifier = Modifier,
  observationStreamFactory: () -> ObservationStream = { ObservationStreamClient() },
  sideContent: @Composable (DeviceColumn, ObservationStream) -> Unit = { column, stream ->
    LayoutInspectorDashboard(
      dataSourceMode = DataSourceMode.Real,
      observationStream = stream,
      deviceId = column.deviceId,
      platform = if (column.platform == Platform.Ios) "ios" else "android",
    )
  },
) {
  var hierarchyA by remember(columnA.deviceId) { mutableStateOf<ParsedHierarchy?>(null) }
  var hierarchyB by remember(columnB.deviceId) { mutableStateOf<ParsedHierarchy?>(null) }
  val diff =
    remember(hierarchyA, hierarchyB) {
      val a = hierarchyA
      val b = hierarchyB
      if (a != null && b != null) diffHierarchies(a.root, b.root) else null
    }

  Column(modifier.fillMaxSize().semantics { contentDescription = "Two-device compare" }) {
    Row(Modifier.weight(1f).fillMaxWidth()) {
      CompareSide(
        column = columnA,
        observationStreamFactory = observationStreamFactory,
        sideContent = sideContent,
        onHierarchy = { hierarchyA = it },
        modifier = Modifier.weight(1f).fillMaxHeight(),
      )
      CompareSide(
        column = columnB,
        observationStreamFactory = observationStreamFactory,
        sideContent = sideContent,
        onHierarchy = { hierarchyB = it },
        modifier = Modifier.weight(1f).fillMaxHeight(),
      )
    }
    HierarchyDiffStrip(
      diff = diff,
      labelA = columnA.name,
      labelB = columnB.name,
      modifier = Modifier.fillMaxWidth().height(DIFF_STRIP_HEIGHT_DP.dp),
    )
  }
}

/**
 * One device's pane in the compare view. Owns a per-device [ObservationStream] with the same
 * connect/dispose lifecycle as [LayoutFacet], collects its hierarchy updates into a parsed tree
 * reported via [onHierarchy], and renders the pane body via [sideContent].
 */
@Composable
private fun CompareSide(
  column: DeviceColumn,
  observationStreamFactory: () -> ObservationStream,
  sideContent: @Composable (DeviceColumn, ObservationStream) -> Unit,
  onHierarchy: (ParsedHierarchy?) -> Unit,
  modifier: Modifier,
) {
  var stream by remember(column.deviceId) { mutableStateOf<ObservationStream?>(null) }
  DisposableEffect(column.deviceId) {
    val connected = observationStreamFactory().also { it.connect(deviceId = column.deviceId) }
    stream = connected
    onDispose {
      connected.dispose()
      stream = null
    }
  }
  val activeStream = stream ?: return
  LaunchedEffect(activeStream) {
    activeStream.hierarchyUpdates.collect { update ->
      val json = update.data ?: return@collect
      val parsed = withContext(Dispatchers.Default) { parseHierarchyFromJson(json) }
      if (parsed != null) onHierarchy(parsed)
    }
  }
  Box(modifier) { sideContent(column, activeStream) }
}

/**
 * The diff summary strip beneath the two panes: a one-line count summary plus a scrollable list of
 * the differing nodes (equal nodes are omitted to keep the strip focused). Renders loading and
 * matched states so a single-device or still-loading compare never shows an empty strip.
 */
@Composable
private fun HierarchyDiffStrip(
  diff: HierarchyDiff?,
  labelA: String,
  labelB: String,
  modifier: Modifier,
) {
  Column(
    modifier
      .background(MaterialTheme.colorScheme.surface)
      .padding(horizontal = 12.dp, vertical = 8.dp)
      .semantics { contentDescription = "Hierarchy diff" }
  ) {
    if (diff == null) {
      Text(
        "Waiting for both device hierarchies…",
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    } else {
      DiffSummaryLine(diff, labelA, labelB)
      Spacer(Modifier.height(6.dp))
      DiffEntryList(diff, labelA, labelB)
    }
  }
}

@Composable
private fun DiffSummaryLine(diff: HierarchyDiff, labelA: String, labelB: String) {
  Text(
    "⧉ $labelA vs $labelB — +${diff.onlyInA} only in $labelA, " +
      "-${diff.onlyInB} only in $labelB, ~${diff.changed} changed",
    style = MaterialTheme.typography.labelLarge,
    fontWeight = FontWeight.SemiBold,
    maxLines = 1,
    overflow = TextOverflow.Ellipsis,
  )
}

@Composable
private fun DiffEntryList(diff: HierarchyDiff, labelA: String, labelB: String) {
  val differing = diff.entries.filter { it.status != NodeDiffStatus.Equal }
  if (differing.isEmpty()) {
    Text(
      "Hierarchies match",
      style = MaterialTheme.typography.labelMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    return
  }
  Column(
    Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
    verticalArrangement = Arrangement.spacedBy(2.dp),
  ) {
    for (entry in differing) {
      DiffEntryRow(entry, labelA, labelB)
    }
  }
}

@Composable
private fun DiffEntryRow(entry: HierarchyDiffEntry, labelA: String, labelB: String) {
  val description = diffRowDescription(entry, labelA, labelB)
  Row(
    modifier = Modifier.fillMaxWidth().semantics { contentDescription = description },
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(Modifier.size(10.dp).background(diffColor(entry.status)))
    Spacer(Modifier.width(8.dp))
    Text(
      description,
      style = MaterialTheme.typography.labelMedium,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

private fun diffColor(status: NodeDiffStatus): Color =
  when (status) {
    NodeDiffStatus.OnlyInA -> OnlyInAColor
    NodeDiffStatus.OnlyInB -> OnlyInBColor
    NodeDiffStatus.Changed -> ChangedColor
    NodeDiffStatus.Equal -> Color.Transparent
  }

private fun diffRowDescription(entry: HierarchyDiffEntry, labelA: String, labelB: String): String {
  val node = entry.a ?: entry.b
  val label =
    node?.resourceId?.takeIf { it.isNotBlank() }
      ?: node?.text?.takeIf { it.isNotBlank() }
      ?: node?.contentDescription?.takeIf { it.isNotBlank() }
      ?: node?.className
      ?: "node"
  return when (entry.status) {
    NodeDiffStatus.OnlyInA -> "Only in $labelA: $label"
    NodeDiffStatus.OnlyInB -> "Only in $labelB: $label"
    NodeDiffStatus.Changed -> "Changed: $label"
    NodeDiffStatus.Equal -> label
  }
}
