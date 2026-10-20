package dev.jasonpearson.automobile.desktop.core.failures

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun FailureDetailView(
  failure: FailureGroup,
  onBack: () -> Unit,
  onNavigateToScreen: (String) -> Unit,
  onNavigateToTest: (String) -> Unit,
  onNavigateToSource: (fileName: String, lineNumber: Int) -> Unit,
) {
  val memory = rememberFailureDetailMemory(failure)
  with(memory) {
    val colors = SharedTheme.globalColors

    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
      // Back button
      Text(
        "← Back",
        fontSize = 12.sp,
        color = Color(0xFF2196F3),
        modifier =
          Modifier.clickable(onClick = onBack)
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(bottom = 12.dp),
      )

      FailureHeader(failure)
      // Captures gallery (if available)
      CaptureGallery(failure)

      FailureErrorMessage(failure)
      // Stack trace with clickable lines
      FailureStackTrace(failure, onNavigateToSource)

      // Tool call info (for tool failures)
      val toolCallInfo = failure.toolCallInfo
      if (toolCallInfo != null) {
        Spacer(Modifier.height(16.dp))
        SectionHeader("Tool Call Details")
        ToolCallDetailsSection(
          toolCallInfo = toolCallInfo,
          expandedState = expandedState,
          onToggle = { expandedState = expandedState.toggle(it) },
        )
      }

      // Screen breakdown histogram
      FailureScreens(failure, onNavigateToScreen)

      // Device breakdown
      FailureDevices(failure)

      // Version breakdown
      FailureVersions(failure)

      // Affected tests
      FailureTests(failure, onNavigateToTest)

      // Recent occurrences for drill-down
      FailureOccurrences(failure)

      FailureActions(failure)

      Spacer(Modifier.height(16.dp))
    }
  }
}

@Composable
internal fun FailureHeader(failure: FailureGroup) {
  val colors = SharedTheme.globalColors
  // Header with badges
  Row(
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Badge(failure.type.icon + " " + failure.type.label, failure.type.color)
    Badge(failure.severity.label, failure.severity.color)
  }

  Text(
    failure.title,
    fontSize = 16.sp,
    fontWeight = FontWeight.Medium,
    modifier = Modifier.padding(top = 8.dp),
  )

  // Summary stats row
  Row(
    horizontalArrangement = Arrangement.spacedBy(16.dp),
    modifier = Modifier.padding(top = 8.dp, bottom = 16.dp),
  ) {
    Text(
      "${failure.totalCount} occurrences",
      fontSize = 12.sp,
      color = colors.text.normal.copy(alpha = 0.6f),
    )
    Text(
      "${failure.uniqueSessions} sessions",
      fontSize = 12.sp,
      color = colors.text.normal.copy(alpha = 0.6f),
    )
  }
}

@Composable
internal fun Badge(text: String, color: Color) {
  Box(
    modifier =
      Modifier.background(color.copy(alpha = 0.15f), RoundedCornerShape(4.dp))
        .padding(horizontal = 8.dp, vertical = 4.dp),
  ) {
    Text(text, fontSize = 11.sp, color = color)
  }
}

@Composable
internal fun CaptureCard(capture: FailureCapture) {
  val colors = SharedTheme.globalColors
  val icon = if (capture.type == CaptureType.Video) "🎬" else "📸"

  Column(
    horizontalAlignment = Alignment.CenterHorizontally,
    modifier =
      Modifier.width(100.dp)
        .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(6.dp))
        .clickable { /* TODO: Open capture */ }
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(8.dp),
  ) {
    Text(icon, fontSize = 24.sp)
    Text(
      capture.deviceModel,
      fontSize = 9.sp,
      color = colors.text.normal.copy(alpha = 0.6f),
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.padding(top = 4.dp),
    )
  }
}

@Composable
internal fun StackTraceLine(
  element: StackTraceElement,
  onNavigateToSource: (String, Int) -> Unit,
) {
  val colors = SharedTheme.globalColors
  val lineText = buildString {
    append("at ${element.className}.${element.methodName}")
    if (element.fileName != null && element.lineNumber != null) {
      append("(${element.fileName}:${element.lineNumber})")
    }
  }
  val isClickable = element.isAppCode && element.fileName != null && element.lineNumber != null

  Text(
    lineText,
    fontSize = 11.sp,
    fontFamily = FontFamily.Monospace,
    color = if (element.isAppCode) Color(0xFF2196F3) else colors.text.normal.copy(alpha = 0.6f),
    modifier =
      Modifier.fillMaxWidth()
        .then(
          if (isClickable)
            Modifier.clickable {
                onNavigateToSource(
                  requireNotNull(element.fileName) { "Clickable stack frame requires a file" },
                  requireNotNull(element.lineNumber) { "Clickable stack frame requires a line" },
                )
              }
              .pointerHoverIcon(PointerIcon.Hand)
          else Modifier,
        )
        .padding(vertical = 2.dp, horizontal = 4.dp),
  )
}

@Composable
internal fun FailureDetailMemory.CaptureGallery(failure: FailureGroup) {
  val colors = SharedTheme.globalColors
  if (failure.recentCaptures.isNotEmpty()) {
    SectionHeader("Captures (${failure.recentCaptures.size})")
    Row(
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      modifier = Modifier.horizontalScroll(rememberScrollState()),
    ) {
      expandedState.visible(FailureSection.Captures, failure.recentCaptures).forEach { capture ->
        CaptureCard(capture = capture)
      }
    }
    // The daemon caps captures at 5 (src/db/failureAnalyticsRepository.ts).
    // Offer expansion only beyond the preview limit; no capture total is available.
    expansionLinkLabel(
        noun = "captures",
        loadedCount = failure.recentCaptures.size,
        totalCount = failure.recentCaptures.size,
        expanded = expandedState.isExpanded(FailureSection.Captures),
      )
      ?.let { label ->
        ViewAllLink(label) { expandedState = expandedState.toggle(FailureSection.Captures) }
      }
    Spacer(Modifier.height(16.dp))
  }
}

@Composable
internal fun FailureDetailMemory.FailureStackTrace(
  failure: FailureGroup,
  onNavigateToSource: (String, Int) -> Unit,
) {
  val colors = SharedTheme.globalColors
  if (failure.stackTraceElements.isNotEmpty()) {
    Spacer(Modifier.height(16.dp))
    SectionHeader("Stack Trace")
    Column(
      modifier =
        Modifier.fillMaxWidth()
          .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
          .padding(8.dp),
    ) {
      failure.stackTraceElements.forEach { element ->
        StackTraceLine(element = element, onNavigateToSource = onNavigateToSource)
      }
    }
  }
}

@Composable
internal fun FailureErrorMessage(failure: FailureGroup) {
  val colors = SharedTheme.globalColors
  // Error message
  SectionHeader("Error Message")
  Box(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(6.dp))
        .padding(12.dp),
  ) {
    Text(
      failure.message,
      fontSize = 12.sp,
      fontFamily = FontFamily.Monospace,
      color = Color(0xFFE53935),
    )
  }
}

@Composable
internal fun FailureActions(failure: FailureGroup) {
  // Actions
  Spacer(Modifier.height(24.dp))
  SectionHeader("Actions")
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Row(
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      modifier = Modifier.fillMaxWidth(),
    ) {
      ActionCard(
        "📋",
        "Copy Logs",
        "All ${failure.totalCount} occurrences",
        Modifier.weight(1f),
      ) {}
      ActionCard("📦", "Export Bundle", "Debug data package", Modifier.weight(1f)) {}
    }
    ActionCard("🔄", "Reproduce", "Replay test to failure point", Modifier.fillMaxWidth()) {}
  }
}
