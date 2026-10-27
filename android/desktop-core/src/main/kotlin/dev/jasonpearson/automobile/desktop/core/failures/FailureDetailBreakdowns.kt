package dev.jasonpearson.automobile.desktop.core.failures

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun FailureDetailMemory.FailureScreens(
  failure: FailureGroup,
  onNavigateToScreen: (String) -> Unit,
) {
  val colors = SharedTheme.globalColors
  if (failure.screenBreakdown.isNotEmpty()) {
    Spacer(Modifier.height(16.dp))
    SectionHeader("Screens Visited (across ${failure.totalCount} occurrences)")
    ScreenBreakdownSection(
      breakdown = expandedState.visible(FailureSection.Screens, failure.screenBreakdown),
      failureScreens = failure.failureScreens,
      onNavigateToScreen = onNavigateToScreen,
    )
    if (failure.screenBreakdown.size > 5) {
      ViewAllLink(
        if (expandedState.isExpanded(FailureSection.Screens)) "Show less"
        else "View all ${failure.screenBreakdown.size} screens",
      ) {
        expandedState = expandedState.toggle(FailureSection.Screens)
      }
    }
  }
}

@Composable
internal fun FailureDetailMemory.FailureDevices(failure: FailureGroup) {
  val colors = SharedTheme.globalColors
  if (failure.deviceBreakdown.isNotEmpty()) {
    Spacer(Modifier.height(16.dp))
    SectionHeader("Devices (${failure.deviceBreakdown.size} models)")
    BreakdownList(
      items =
        expandedState.visible(FailureSection.Devices, failure.deviceBreakdown).map { device ->
          BreakdownItem(
            label = device.deviceModel,
            sublabel = device.os,
            count = device.count,
            percentage = device.percentage,
          )
        },
    )
    if (failure.deviceBreakdown.size > 5) {
      ViewAllLink(
        if (expandedState.isExpanded(FailureSection.Devices)) "Show less"
        else "View all ${failure.deviceBreakdown.size} devices",
      ) {
        expandedState = expandedState.toggle(FailureSection.Devices)
      }
    }
  }
}

@Composable
internal fun FailureDetailMemory.FailureVersions(failure: FailureGroup) {
  val colors = SharedTheme.globalColors
  if (failure.versionBreakdown.isNotEmpty()) {
    Spacer(Modifier.height(16.dp))
    SectionHeader("App Versions (${failure.versionBreakdown.size})")
    BreakdownList(
      items =
        expandedState.visible(FailureSection.Versions, failure.versionBreakdown).map { version ->
          BreakdownItem(
            label = version.version,
            sublabel = null,
            count = version.count,
            percentage = version.percentage,
          )
        },
    )
    if (failure.versionBreakdown.size > 5) {
      ViewAllLink(
        if (expandedState.isExpanded(FailureSection.Versions)) "Show less"
        else "View all ${failure.versionBreakdown.size} versions",
      ) {
        expandedState = expandedState.toggle(FailureSection.Versions)
      }
    }
  }
}

@Composable
internal fun FailureDetailMemory.FailureTests(
  failure: FailureGroup,
  onNavigateToTest: (String) -> Unit,
) {
  val colors = SharedTheme.globalColors
  if (failure.affectedTests.isNotEmpty()) {
    Spacer(Modifier.height(16.dp))
    SectionHeader("Affected Tests (${failure.affectedTests.size})")
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
      expandedState
        .visible(
          FailureSection.Tests,
          failure.affectedTests.entries.sortedByDescending { it.value },
        )
        .forEach { (testName, count) ->
          Row(
            modifier =
              Modifier.fillMaxWidth()
                .background(
                  colors.text.normal.copy(alpha = 0.03f),
                  RoundedCornerShape(6.dp),
                )
                .clickable { onNavigateToTest(testName) }
                .pointerHoverIcon(PointerIcon.Hand)
                .padding(10.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Text(testName, fontSize = 12.sp, modifier = Modifier.weight(1f))
            Text(
              "${count}x",
              fontSize = 11.sp,
              color = colors.text.normal.copy(alpha = 0.5f),
              modifier = Modifier.padding(end = 8.dp),
            )
            Text("View →", fontSize = 11.sp, color = Color(0xFF2196F3))
          }
        }
      if (failure.affectedTests.size > 5) {
        ViewAllLink(
          if (expandedState.isExpanded(FailureSection.Tests)) "Show less"
          else "View all ${failure.affectedTests.size} tests",
        ) {
          expandedState = expandedState.toggle(FailureSection.Tests)
        }
      }
    }
  }
}

@Composable
internal fun FailureDetailMemory.FailureOccurrences(failure: FailureGroup) {
  val colors = SharedTheme.globalColors
  if (failure.sampleOccurrences.isNotEmpty()) {
    Spacer(Modifier.height(16.dp))
    SectionHeader("Recent Occurrences")
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
      expandedState.visible(FailureSection.Occurrences, failure.sampleOccurrences).forEach {
        occurrence ->
        OccurrenceRow(occurrence = occurrence)
      }
      // The daemon caps sample occurrences at 6 (src/db/failureAnalyticsRepository.ts).
      // Offer expansion only beyond the preview limit and label partial lists as N of TOTAL.
      expansionLinkLabel(
          noun = "occurrences",
          loadedCount = failure.sampleOccurrences.size,
          totalCount = failure.totalCount,
          expanded = expandedState.isExpanded(FailureSection.Occurrences),
        )
        ?.let { label ->
          ViewAllLink(label) { expandedState = expandedState.toggle(FailureSection.Occurrences) }
        }
    }
  }
}

@Composable
internal fun ScreenBreakdownSection(
  breakdown: List<ScreenBreakdown>,
  failureScreens: Map<String, Int>,
  onNavigateToScreen: (String) -> Unit,
) {
  val colors = SharedTheme.globalColors
  val maxVisits = breakdown.maxOfOrNull { it.visitCount } ?: 1

  Column(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
        .padding(12.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    breakdown
      .sortedByDescending { it.visitCount }
      .forEach { screen ->
        val failureCount = failureScreens[screen.screenName] ?: 0
        val isFailureScreen = failureCount > 0

        Row(
          verticalAlignment = Alignment.CenterVertically,
          modifier =
            Modifier.fillMaxWidth()
              .clickable { onNavigateToScreen(screen.screenName) }
              .pointerHoverIcon(PointerIcon.Hand),
        ) {
          // Screen name with failure indicator
          Row(modifier = Modifier.width(100.dp)) {
            if (isFailureScreen) {
              Text("💥 ", fontSize = 10.sp)
            }
            Text(
              screen.screenName,
              fontSize = 11.sp,
              color = if (isFailureScreen) Color(0xFFE53935) else colors.text.normal,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
            )
          }

          // Bar
          Box(modifier = Modifier.weight(1f).height(16.dp).padding(horizontal = 8.dp)) {
            // Visit bar
            Box(
              modifier =
                Modifier.fillMaxWidth(screen.visitCount.toFloat() / maxVisits)
                  .height(16.dp)
                  .background(
                    if (isFailureScreen) Color(0xFFE53935).copy(alpha = 0.3f)
                    else colors.text.normal.copy(alpha = 0.15f),
                    RoundedCornerShape(2.dp),
                  ),
            )
          }

          // Count
          Text(
            "${screen.visitCount}",
            fontSize = 10.sp,
            color = colors.text.normal.copy(alpha = 0.6f),
            modifier = Modifier.width(40.dp),
          )
        }
      }
  }
}

@Composable
internal fun BreakdownList(items: List<BreakdownItem>) {
  val colors = SharedTheme.globalColors

  Column(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
        .padding(12.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    items
      .sortedByDescending { it.count }
      .forEach { item ->
        Row(
          verticalAlignment = Alignment.CenterVertically,
          modifier = Modifier.fillMaxWidth(),
        ) {
          Column(modifier = Modifier.width(120.dp)) {
            Text(item.label, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (item.sublabel != null) {
              Text(
                item.sublabel,
                fontSize = 9.sp,
                color = colors.text.normal.copy(alpha = 0.5f),
              )
            }
          }

          // Bar
          Box(modifier = Modifier.weight(1f).height(12.dp).padding(horizontal = 8.dp)) {
            Box(
              modifier =
                Modifier.fillMaxWidth(item.percentage / 100f)
                  .height(12.dp)
                  .background(
                    Color(0xFF2196F3).copy(alpha = 0.4f),
                    RoundedCornerShape(2.dp),
                  ),
            )
          }

          Text(
            "${item.count} (${item.percentage.toInt()}%)",
            fontSize = 10.sp,
            color = colors.text.normal.copy(alpha = 0.6f),
          )
        }
      }
  }
}

@Composable
internal fun OccurrenceRow(occurrence: FailureOccurrence) {
  val colors = SharedTheme.globalColors
  val timeAgo = formatTimeAgo(occurrence.timestamp)

  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
        .clickable { /* TODO: Show occurrence detail */ }
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(10.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Column(modifier = Modifier.weight(1f)) {
      Text(occurrence.deviceModel, fontSize = 11.sp)
      Text(
        "${occurrence.appVersion} • ${occurrence.screenAtFailure ?: "Unknown screen"}",
        fontSize = 10.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
      )
    }
    Column(horizontalAlignment = Alignment.End) {
      Text(timeAgo, fontSize = 10.sp, color = colors.text.normal.copy(alpha = 0.5f))
      if (occurrence.capturePath != null) {
        Text(
          if (occurrence.captureType == CaptureType.Video) "🎬" else "📸",
          fontSize = 12.sp,
        )
      }
    }
  }
}
