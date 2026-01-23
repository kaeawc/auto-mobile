package dev.jasonpearson.automobile.ide

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.jetbrains.jewel.foundation.theme.JewelTheme
import org.jetbrains.jewel.ui.component.Link
import org.jetbrains.jewel.ui.component.TabData
import org.jetbrains.jewel.ui.component.TabStrip
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.theme.defaultTabStyle

enum class Dashboard(val title: String) {
  Navigation("Navigation"),
  Test("Test"),
  Performance("Performance"),
  Reliability("Reliability"),
}

// Navigation Dashboard sections
enum class NavigationSection { Overview, FlowMap, ScreenDetail, TransitionDetail }

// Test Dashboard sections
enum class TestSection { Overview, TestDetail, StepDetail }

// Performance Dashboard sections
enum class PerformanceSection { Overview, MetricDetail, AccessibilityLayout }

// Reliability Dashboard sections
enum class ReliabilitySection { Overview, FailureDetail }

@Composable
fun AutoMobileToolWindowContent() {
  var selectedIndex by remember { mutableIntStateOf(0) }
  val dashboards = Dashboard.entries

  Column(modifier = Modifier.fillMaxSize()) {
    TabStrip(
        tabs =
            dashboards.mapIndexed { index, dashboard ->
              TabData.Default(
                  selected = index == selectedIndex,
                  content = { Text(dashboard.title) },
                  closable = false,
                  onClick = { selectedIndex = index },
              )
            },
        style = JewelTheme.defaultTabStyle,
        modifier = Modifier.fillMaxWidth(),
    )

    Box(modifier = Modifier.fillMaxSize().padding(16.dp)) {
      when (dashboards[selectedIndex]) {
        Dashboard.Navigation -> NavigationDashboard()
        Dashboard.Test -> TestDashboard()
        Dashboard.Performance -> PerformanceDashboard()
        Dashboard.Reliability -> ReliabilityDashboard()
      }
    }
  }
}

@Composable
private fun NavigationDashboard() {
  var currentSection by remember { mutableStateOf(NavigationSection.Overview) }

  when (currentSection) {
    NavigationSection.Overview ->
        DashboardOverview(
            title = "Flows & Navigation",
            description = "Understand app structure, user flows, and reachable states.",
            sections =
                listOf(
                    SectionItem("Flow Map", "Visual navigation graph of screens and transitions") {
                      currentSection = NavigationSection.FlowMap
                    },
                    SectionItem("Screen Detail", "Everything known about one UI state") {
                      currentSection = NavigationSection.ScreenDetail
                    },
                    SectionItem("Transition Detail", "What happens between screens") {
                      currentSection = NavigationSection.TransitionDetail
                    },
                ),
        )
    NavigationSection.FlowMap ->
        SectionDetail(
            title = "Flow Map",
            description = "Visual navigation graph representing screens, transitions, and entry points.",
            features =
                listOf(
                    "Screen nodes (activities, fragments, composables)",
                    "Edges (user actions, system events, deep links)",
                    "Entry points (launch, notification, intent)",
                    "Test coverage overlays",
                    "Failure markers",
                ),
            onBack = { currentSection = NavigationSection.Overview },
        )
    NavigationSection.ScreenDetail ->
        SectionDetail(
            title = "Screen Detail",
            description = "Everything known about one UI state.",
            features =
                listOf(
                    "Screen identity & hierarchy",
                    "Screenshot(s)",
                    "View tree summary",
                    "Accessibility summary",
                    "Performance summary",
                    "Tests that touch this screen",
                ),
            onBack = { currentSection = NavigationSection.Overview },
        )
    NavigationSection.TransitionDetail ->
        SectionDetail(
            title = "Transition Detail",
            description = "What happens between screens.",
            features =
                listOf(
                    "Triggering action (tap, intent, system)",
                    "Preconditions",
                    "Latency stats",
                    "Failure rate",
                    "Tests that validate this transition",
                ),
            onBack = { currentSection = NavigationSection.Overview },
        )
  }
}

@Composable
private fun TestDashboard() {
  var currentSection by remember { mutableStateOf(TestSection.Overview) }

  when (currentSection) {
    TestSection.Overview ->
        DashboardOverview(
            title = "Testing",
            description = "Create, run, analyze, and iterate on UI tests.",
            sections =
                listOf(
                    SectionItem("Test Overview", "High-level view of all tests and recent runs") {
                      currentSection = TestSection.TestDetail
                    },
                    SectionItem("Test Detail", "Step-by-step breakdown of a single test") {
                      currentSection = TestSection.TestDetail
                    },
                    SectionItem("Step Detail", "Microscopic inspection of a single interaction") {
                      currentSection = TestSection.StepDetail
                    },
                ),
        )
    TestSection.TestDetail ->
        SectionDetail(
            title = "Test Detail",
            description = "Step-by-step breakdown of a single test.",
            features =
                listOf(
                    "Ordered step list",
                    "Screenshot per step",
                    "Assertions",
                    "Timing per step",
                    "Input/output events",
                    "Errors and warnings",
                ),
            onBack = { currentSection = TestSection.Overview },
        )
    TestSection.StepDetail ->
        SectionDetail(
            title = "Step Detail",
            description = "Microscopic inspection of a single interaction.",
            features =
                listOf(
                    "Raw UI snapshot",
                    "Targeted UI element",
                    "Accessibility metadata",
                    "Gesture details",
                    "Network calls at that moment",
                    "Performance deltas",
                ),
            onBack = { currentSection = TestSection.Overview },
        )
  }
}

@Composable
private fun PerformanceDashboard() {
  var currentSection by remember { mutableStateOf(PerformanceSection.Overview) }

  when (currentSection) {
    PerformanceSection.Overview ->
        DashboardOverview(
            title = "Performance & Quality",
            description = "Analyze non-functional behavior across UI, system, and runtime.",
            sections =
                listOf(
                    SectionItem("Performance Overview", "Aggregated health metrics") {
                      currentSection = PerformanceSection.MetricDetail
                    },
                    SectionItem("Metric Detail", "Deep dive into one metric over time") {
                      currentSection = PerformanceSection.MetricDetail
                    },
                    SectionItem("Accessibility & Layout", "Violations and layout analysis") {
                      currentSection = PerformanceSection.AccessibilityLayout
                    },
                ),
        )
    PerformanceSection.MetricDetail ->
        SectionDetail(
            title = "Metric Detail",
            description = "Deep dive into one metric over time.",
            features =
                listOf(
                    "Timeline graph",
                    "Event overlays (screen changes, test steps)",
                    "Threshold markers",
                    "Historical comparisons",
                ),
            onBack = { currentSection = PerformanceSection.Overview },
        )
    PerformanceSection.AccessibilityLayout ->
        SectionDetail(
            title = "Accessibility & Layout",
            description = "Accessibility violations and layout analysis.",
            features =
                listOf(
                    "Accessibility violations",
                    "Missing labels",
                    "Touch target size issues",
                    "Layout bounds",
                    "Overdraw hints",
                ),
            onBack = { currentSection = PerformanceSection.Overview },
        )
  }
}

@Composable
private fun ReliabilityDashboard() {
  var currentSection by remember { mutableStateOf(ReliabilitySection.Overview) }

  when (currentSection) {
    ReliabilitySection.Overview ->
        DashboardOverview(
            title = "Reliability",
            description = "Centralized failure intelligence for crashes and ANRs.",
            sections =
                listOf(
                    SectionItem("Crash & ANR Overview", "Failure list with frequency and impact") {
                      currentSection = ReliabilitySection.FailureDetail
                    },
                    SectionItem("Failure Detail", "Full context of a failure event") {
                      currentSection = ReliabilitySection.FailureDetail
                    },
                ),
        )
    ReliabilitySection.FailureDetail ->
        SectionDetail(
            title = "Failure Detail",
            description = "Full context of a failure event.",
            features =
                listOf(
                    "Stack trace",
                    "Screen at failure",
                    "Test context",
                    "Performance state",
                    "Network state",
                ),
            onBack = { currentSection = ReliabilitySection.Overview },
        )
  }
}

private data class SectionItem(
    val title: String,
    val description: String,
    val onClick: () -> Unit,
)

@Composable
private fun DashboardOverview(title: String, description: String, sections: List<SectionItem>) {
  val colors = JewelTheme.globalColors

  Column(modifier = Modifier.fillMaxSize()) {
    Text(title, fontSize = 16.sp)
    Text(
        description,
        color = colors.text.normal.copy(alpha = 0.7f),
        modifier = Modifier.padding(top = 4.dp, bottom = 16.dp),
    )

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
      sections.forEach { section ->
        Column(
            modifier =
                Modifier.fillMaxWidth()
                    .clickable(onClick = section.onClick)
                    .pointerHoverIcon(PointerIcon.Hand)
                    .padding(vertical = 4.dp),
        ) {
          Link(section.title, onClick = section.onClick)
          Text(
              section.description,
              color = colors.text.normal.copy(alpha = 0.5f),
              fontSize = 12.sp,
              modifier = Modifier.padding(start = 2.dp),
          )
        }
      }
    }
  }
}

@Composable
private fun SectionDetail(
    title: String,
    description: String,
    features: List<String>,
    onBack: () -> Unit,
) {
  val colors = JewelTheme.globalColors

  Column(modifier = Modifier.fillMaxSize()) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.padding(bottom = 8.dp),
    ) {
      Link("← Back", onClick = onBack)
    }

    Text(title, fontSize = 16.sp)
    Text(
        description,
        color = colors.text.normal.copy(alpha = 0.7f),
        modifier = Modifier.padding(top = 4.dp, bottom = 16.dp),
    )

    Text("Features:", fontSize = 12.sp, color = colors.text.normal.copy(alpha = 0.6f))
    Column(modifier = Modifier.padding(top = 8.dp)) {
      features.forEach { feature ->
        Text(
            "• $feature",
            color = colors.text.normal.copy(alpha = 0.5f),
            modifier = Modifier.padding(vertical = 2.dp),
        )
      }
    }
  }
}
