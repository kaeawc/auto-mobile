package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

private val OnlyInAColor = Color(0xFF4CAF50) // green: reached by build A only
private val OnlyInBColor = Color(0xFF4DABF7) // blue: reached by build B only

/**
 * Lens picker over the app-union graph (#4987): all builds (union), filter to one build (fade or
 * hide the others), or compare two builds. Only meaningful with two or more observed [builds].
 */
@Composable
internal fun BuildLensBar(
  builds: List<ProvenanceBuildKey>,
  lens: BuildLens,
  onLensChange: (BuildLens) -> Unit,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  Column(
    modifier =
      modifier
        .background(colors.text.normal.copy(alpha = 0.06f), RoundedCornerShape(8.dp))
        .padding(6.dp),
    verticalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    // Action chips get their own fixed row so a long build history can never push them out of a
    // narrow pane; the build chips below scroll horizontally instead.
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
      LensChip("All builds", "Build lens: all builds", lens is BuildLens.Union) {
        onLensChange(BuildLens.Union)
      }
      if (lens is BuildLens.Filter) {
        LensChip("Hide others", "Build lens: hide other builds", lens.hideOtherBuilds) {
          onLensChange(lens.copy(hideOtherBuilds = !lens.hideOtherBuilds))
        }
      }
      LensChip("Compare", "Build lens: compare builds", lens is BuildLens.Compare) {
        onLensChange(defaultCompare(builds, lens))
      }
    }
    if (lens !is BuildLens.Compare) {
      Row(
        modifier = Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
      ) {
        builds.forEach { build ->
          val label = NavigationBuildLens.label(build)
          val selected = lens is BuildLens.Filter && lens.build == build
          LensChip(label, "Build lens: filter $label", selected) {
            val hide = (lens as? BuildLens.Filter)?.hideOtherBuilds ?: false
            onLensChange(BuildLens.Filter(build, hide))
          }
        }
      }
    }
    if (lens is BuildLens.Compare) {
      CompareSidePicker("A", builds, lens.a) { onLensChange(lens.copy(a = it)) }
      CompareSidePicker("B", builds, lens.b) { onLensChange(lens.copy(b = it)) }
    }
  }
}

/** Compare the filtered build (or the newest) against the next distinct build. */
private fun defaultCompare(builds: List<ProvenanceBuildKey>, lens: BuildLens): BuildLens {
  if (lens is BuildLens.Compare) return lens
  val a = (lens as? BuildLens.Filter)?.build ?: builds.first()
  val b = builds.firstOrNull { it != a } ?: a
  return BuildLens.Compare(a, b)
}

@Composable
private fun CompareSidePicker(
  side: String,
  builds: List<ProvenanceBuildKey>,
  current: ProvenanceBuildKey,
  onPick: (ProvenanceBuildKey) -> Unit,
) {
  Row(
    modifier = Modifier.horizontalScroll(rememberScrollState()),
    horizontalArrangement = Arrangement.spacedBy(4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(side, fontSize = 11.sp)
    builds.forEach { build ->
      val label = NavigationBuildLens.label(build)
      LensChip(label, "Compare $side: $label", build == current) { onPick(build) }
    }
  }
}

@Composable
private fun LensChip(
  text: String,
  description: String,
  isSelected: Boolean,
  onClick: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  val background =
    if (isSelected) colors.text.normal.copy(alpha = 0.2f)
    else colors.text.normal.copy(alpha = 0.06f)
  Text(
    text,
    fontSize = 11.sp,
    modifier =
      Modifier.background(background, RoundedCornerShape(4.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 6.dp, vertical = 2.dp)
        .semantics {
          contentDescription = description
          selected = isSelected
        },
  )
}

/**
 * Side-by-side two-build compare (#4987), mirroring the two-device hierarchy compare: build A's
 * exclusive screens/transitions on the left, build B's on the right, shared ones summarized.
 */
@Composable
internal fun BuildCompareView(diff: BuildGraphDiff, modifier: Modifier = Modifier) {
  val colors = SharedTheme.globalColors
  val labelA = NavigationBuildLens.label(diff.a)
  val labelB = NavigationBuildLens.label(diff.b)
  val summary = buildDiffSummary(diff)
  Column(modifier = modifier.fillMaxSize().padding(16.dp)) {
    Text("Comparing $labelA ↔ $labelB", fontSize = 16.sp)
    Text(
      summary,
      fontSize = 12.sp,
      color = colors.text.normal.copy(alpha = 0.6f),
      modifier = Modifier.padding(top = 4.dp).semantics { contentDescription = summary },
    )
    Spacer(Modifier.height(12.dp))
    Row(
      modifier = Modifier.fillMaxWidth().weight(1f),
      horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      BuildDiffColumn(diff, BuildDiffStatus.OnlyInA, "Only in A · $labelA", Modifier.weight(1f))
      BuildDiffColumn(diff, BuildDiffStatus.OnlyInB, "Only in B · $labelB", Modifier.weight(1f))
    }
  }
}

/** Deterministic, accessible summary of a build diff. */
internal fun buildDiffSummary(diff: BuildGraphDiff): String {
  if (!diff.hasDifferences) {
    return "No differences: ${diff.screens.size} screens and " +
      "${diff.transitions.size} transitions in both builds"
  }
  fun counts(status: BuildDiffStatus) =
    "${diff.screensWith(status).size} screens, ${diff.transitionsWith(status).size} transitions"
  return "Only in A: ${counts(BuildDiffStatus.OnlyInA)} · " +
    "Only in B: ${counts(BuildDiffStatus.OnlyInB)} · " +
    "In both: ${counts(BuildDiffStatus.InBoth)}"
}

@Composable
private fun BuildDiffColumn(
  diff: BuildGraphDiff,
  status: BuildDiffStatus,
  title: String,
  modifier: Modifier,
) {
  val side = if (status == BuildDiffStatus.OnlyInA) "A" else "B"
  val accent = if (status == BuildDiffStatus.OnlyInA) OnlyInAColor else OnlyInBColor
  Column(modifier = modifier.verticalScroll(rememberScrollState())) {
    Text(title, fontSize = 13.sp, color = accent)
    Spacer(Modifier.height(8.dp))
    diff.screensWith(status).forEach { screen ->
      DiffItem(screen.name, "Only in $side: screen ${screen.name}", accent)
    }
    diff.transitionsWith(status).forEach { transition ->
      val path = "${transition.fromScreen} → ${transition.toScreen}"
      DiffItem(path, "Only in $side: transition $path", accent)
    }
  }
}

@Composable
private fun DiffItem(text: String, description: String, accent: Color) {
  Text(
    text,
    fontSize = 12.sp,
    modifier =
      Modifier.fillMaxWidth()
        .padding(vertical = 2.dp)
        .background(accent.copy(alpha = 0.12f), RoundedCornerShape(4.dp))
        .padding(horizontal = 8.dp, vertical = 4.dp)
        .semantics { contentDescription = description },
  )
}
