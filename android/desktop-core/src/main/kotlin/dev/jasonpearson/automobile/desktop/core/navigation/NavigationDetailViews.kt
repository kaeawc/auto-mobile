package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.components.Link
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
fun FlowMapListView(
  screens: List<ScreenNode>,
  transitions: List<ScreenTransition>,
  onScreenSelected: (String) -> Unit,
  onTransitionSelected: (String) -> Unit,
) {
  val colors = SharedTheme.globalColors
  val scrollState = rememberScrollState()

  Column(modifier = Modifier.fillMaxSize().verticalScroll(scrollState)) {
    Text("Flow Map", fontSize = 16.sp)
    Text(
      "${screens.size} screens discovered • ${transitions.size} transitions",
      color = colors.text.normal.copy(alpha = 0.6f),
      fontSize = 12.sp,
      modifier = Modifier.padding(top = 4.dp, bottom = 16.dp),
    )

    // Screens section
    Text("Screens", fontSize = 13.sp, color = colors.text.normal.copy(alpha = 0.8f))
    Spacer(Modifier.height(8.dp))

    screens.forEach { screen ->
      ScreenNodeRow(
        screen = screen,
        onClick = { onScreenSelected(screen.id) },
      )
      Spacer(Modifier.height(4.dp))
    }

    Spacer(Modifier.height(16.dp))

    // Transitions section
    Text("Transitions", fontSize = 13.sp, color = colors.text.normal.copy(alpha = 0.8f))
    Spacer(Modifier.height(8.dp))

    transitions.forEach { transition ->
      TransitionRow(
        transition = transition,
        onClick = { onTransitionSelected(transition.id) },
      )
      Spacer(Modifier.height(4.dp))
    }
  }
}

@Composable
fun ScreenNodeRow(screen: ScreenNode, onClick: () -> Unit) {
  val colors = SharedTheme.globalColors
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(6.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 12.dp, vertical = 8.dp),
    horizontalArrangement = Arrangement.SpaceBetween,
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Column(modifier = Modifier.weight(1f)) {
      Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(screen.name, fontSize = 13.sp)
        Text(
          screen.type,
          fontSize = 10.sp,
          color = colors.text.normal.copy(alpha = 0.5f),
          modifier =
            Modifier.background(colors.text.normal.copy(alpha = 0.1f), RoundedCornerShape(3.dp))
              .padding(horizontal = 4.dp, vertical = 1.dp),
        )
      }
      Text(
        screen.packageName,
        fontSize = 11.sp,
        color = colors.text.normal.copy(alpha = 0.4f),
      )
    }

    // Transition count
    Text(
      "${screen.transitionCount} →",
      fontSize = 11.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
    )
  }
}

@Composable
fun TransitionRow(
  transition: ScreenTransition,
  onClick: () -> Unit,
  currentScreen: String? = null, // Current screen name - won't be a link
  onScreenClick: ((String) -> Unit)? = null, // Optional: click on screen name to navigate
) {
  val colors = SharedTheme.globalColors
  val triggerIcon =
    when (transition.trigger) {
      "tap" -> "👆"
      "back" -> "←"
      "swipe" -> "↔"
      "intent" -> "⚡"
      else -> "•"
    }

  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
        .then(
          if (onScreenClick == null)
            Modifier.clickable(onClick = onClick).pointerHoverIcon(PointerIcon.Hand)
          else Modifier,
        )
        .padding(horizontal = 12.dp, vertical = 8.dp),
    horizontalArrangement = Arrangement.SpaceBetween,
    verticalAlignment = Alignment.CenterVertically,
  ) {
    TransitionPath(transition, currentScreen, onScreenClick, triggerIcon, Modifier.weight(1f))

    TransitionStatistics(transition)
  }
}

@Composable
fun ScreenDetailView(
  screen: ScreenNode,
  transitions: List<ScreenTransition>,
  onBack: () -> Unit,
  onScreenSelected: (String) -> Unit, // Navigate to another screen by name
  screenshotLoader: ScreenshotLoader? = null,
) {
  val colors = SharedTheme.globalColors
  val scrollState = rememberScrollState()
  val outgoing = transitions.filter { it.fromScreen == screen.name }
  val incoming = transitions.filter { it.toScreen == screen.name }

  Column(modifier = Modifier.fillMaxSize().verticalScroll(scrollState).padding(16.dp)) {
    Link("← Flow Map", onClick = onBack)
    Spacer(Modifier.height(12.dp))

    ScreenHeading(screen)

    Spacer(Modifier.height(20.dp))

    ScreenScreenshot(screen, screenshotLoader)

    Spacer(Modifier.height(20.dp))

    // Stats row
    Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
      StatItem("Outgoing", "${outgoing.size}")
      StatItem("Incoming", "${incoming.size}")
    }

    Spacer(Modifier.height(20.dp))

    ScreenTransitionList("Outgoing Transitions", outgoing, screen.name, onScreenSelected)
    if (outgoing.isNotEmpty()) Spacer(Modifier.height(12.dp))
    ScreenTransitionList("Incoming Transitions", incoming, screen.name, onScreenSelected)
  }
}

@Composable
fun StatItem(label: String, value: String) {
  val colors = SharedTheme.globalColors
  Column {
    Text(value, fontSize = 18.sp)
    Text(label, fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.5f))
  }
}

@Composable
fun TransitionDetailView(
  transition: ScreenTransition,
  onBack: () -> Unit,
  onScreenSelected: (String) -> Unit, // Navigate to a screen by name
) {
  val colors = SharedTheme.globalColors
  val scrollState = rememberScrollState()

  Column(modifier = Modifier.fillMaxSize().verticalScroll(scrollState).padding(16.dp)) {
    Link("← Flow Map", onClick = onBack)
    Spacer(Modifier.height(12.dp))

    // Header
    Text("Transition Detail", fontSize = 16.sp)
    Row(
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      verticalAlignment = Alignment.CenterVertically,
      modifier = Modifier.padding(top = 8.dp),
    ) {
      Link(transition.fromScreen, onClick = { onScreenSelected(transition.fromScreen) })
      Text("→", fontSize = 14.sp, color = colors.text.normal.copy(alpha = 0.4f))
      Link(transition.toScreen, onClick = { onScreenSelected(transition.toScreen) })
    }

    Spacer(Modifier.height(20.dp))

    // Details
    DetailRow("Trigger", transition.trigger.replaceFirstChar { it.uppercase() })
    transition.element?.let { DetailRow("Element", it) }
    DetailRow("Traversals", "${transition.traversalCount}")
    if (transition.avgLatencyMs > 0) {
      DetailRow("Avg Latency", "${transition.avgLatencyMs}ms")
    }
    if (transition.failureRate > 0) {
      DetailRow("Failure Rate", "${(transition.failureRate * 100)}%")
    }

    Spacer(Modifier.height(20.dp))

    // Tests section
    Text("Related Tests", fontSize = 13.sp, color = colors.text.normal.copy(alpha = 0.8f))
    Spacer(Modifier.height(8.dp))
    Text(
      "• NavigationTest.testHomeToSettings()",
      fontSize = 12.sp,
      color = colors.text.normal.copy(alpha = 0.6f),
    )
    Text(
      "• SmokeTest.testBasicNavigation()",
      fontSize = 12.sp,
      color = colors.text.normal.copy(alpha = 0.6f),
    )
  }
}

@Composable
fun DetailRow(label: String, value: String) {
  val colors = SharedTheme.globalColors
  Row(
    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    horizontalArrangement = Arrangement.SpaceBetween,
  ) {
    Text(label, fontSize = 12.sp, color = colors.text.normal.copy(alpha = 0.5f))
    Text(value, fontSize = 12.sp)
  }
}
