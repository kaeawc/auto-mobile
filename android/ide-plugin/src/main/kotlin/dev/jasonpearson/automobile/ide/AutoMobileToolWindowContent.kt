@file:OptIn(ExperimentalFoundationApi::class)

package dev.jasonpearson.automobile.ide

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.jetbrains.jewel.foundation.theme.JewelTheme
import org.jetbrains.jewel.ui.component.Link
import org.jetbrains.jewel.ui.component.TabData
import org.jetbrains.jewel.ui.component.TabStrip
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.component.Tooltip
import org.jetbrains.jewel.ui.theme.defaultTabStyle
import dev.jasonpearson.automobile.ide.navigation.NavigationDashboard

enum class Dashboard(val title: String) {
  Navigation("Navigation"),
  Test("Test"),
  Performance("Performance"),
  Reliability("Reliability"),
}

// Test Dashboard sections
enum class TestSection { Overview, TestDetail, StepDetail }

// Performance Dashboard sections
enum class PerformanceSection { Overview, MetricDetail, AccessibilityLayout }

// Reliability Dashboard sections
enum class ReliabilitySection { Overview, FailureDetail }

// Device types for icons
enum class DeviceType { AndroidEmulator, iOSSimulator }

data class BootedDevice(
    val id: String,
    val name: String,
    val type: DeviceType,
    val status: String = "Running",
    val foregroundApp: String? = null,
)

@Composable
fun AutoMobileToolWindowContent() {
  var selectedIndex by remember { mutableIntStateOf(0) }
  var isLive by remember { mutableStateOf(true) }
  val dashboards = Dashboard.entries

  // Mock booted devices - will be replaced with real data
  var activeDeviceId by remember { mutableStateOf("pixel8") }
  val bootedDevices = remember {
    listOf(
        BootedDevice("pixel8", "Pixel 8 API 35", DeviceType.AndroidEmulator, "Running", "com.example.myapp"),
        BootedDevice("pixel7", "Pixel 7 API 34", DeviceType.AndroidEmulator, "Running", "com.android.launcher3"),
        BootedDevice("iphone15", "iPhone 15 Pro", DeviceType.iOSSimulator, "Booted", "com.apple.springboard"),
    )
  }

  Column(modifier = Modifier.fillMaxSize()) {
    // Global Shell Header
    GlobalShellHeader(
        devices = bootedDevices,
        activeDeviceId = activeDeviceId,
        onDeviceSelected = { activeDeviceId = it },
        isLive = isLive,
        onLiveToggle = { isLive = it },
    )

    // Dashboard Tabs
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

    // Dashboard Content
    when (dashboards[selectedIndex]) {
      Dashboard.Navigation -> NavigationDashboard() // Edge-to-edge canvas
      Dashboard.Test -> Box(Modifier.fillMaxSize().padding(16.dp)) { TestDashboard() }
      Dashboard.Performance -> Box(Modifier.fillMaxSize().padding(16.dp)) { PerformanceDashboard() }
      Dashboard.Reliability -> Box(Modifier.fillMaxSize().padding(16.dp)) { ReliabilityDashboard() }
    }
  }
}

@Composable
private fun GlobalShellHeader(
    devices: List<BootedDevice>,
    activeDeviceId: String,
    onDeviceSelected: (String) -> Unit,
    isLive: Boolean,
    onLiveToggle: (Boolean) -> Unit,
) {
  val colors = JewelTheme.globalColors

  Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
  ) {
    // Left side: Title + Device icons
    Row(
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
      Text("AutoMobile", fontSize = 13.sp)

      // Device icons
      Row(
          horizontalArrangement = Arrangement.spacedBy(4.dp),
          verticalAlignment = Alignment.CenterVertically,
      ) {
        devices.forEach { device ->
          DeviceIcon(
              device = device,
              isActive = device.id == activeDeviceId,
              isLive = isLive,
              onClick = { onDeviceSelected(device.id) },
          )
        }
      }
    }

    // Live toggle
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
          "Live",
          fontSize = 11.sp,
          color = if (isLive) colors.text.normal else colors.text.normal.copy(alpha = 0.5f),
      )
      LiveToggle(isLive = isLive, onToggle = onLiveToggle)
    }
  }
}

@Composable
private fun DeviceIcon(
    device: BootedDevice,
    isActive: Boolean,
    isLive: Boolean,
    onClick: () -> Unit,
) {
  val colors = JewelTheme.globalColors
  val bgColor =
      if (isActive) colors.text.normal.copy(alpha = 0.15f)
      else colors.text.normal.copy(alpha = 0.05f)
  val borderColor =
      if (isActive && isLive) Color(0xFF4CAF50)
      else if (isActive) colors.text.normal.copy(alpha = 0.4f)
      else Color.Transparent
  val iconColor =
      if (isActive) colors.text.normal
      else colors.text.normal.copy(alpha = 0.4f)

  Tooltip(
      tooltip = {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
          Text(device.name, fontSize = 12.sp)
          Text(
              "Status: ${device.status}",
              fontSize = 11.sp,
              color = colors.text.normal.copy(alpha = 0.7f),
          )
          device.foregroundApp?.let { app ->
            Text(
                "App: $app",
                fontSize = 11.sp,
                color = colors.text.normal.copy(alpha = 0.7f),
            )
          }
        }
      },
  ) {
    Box(
        modifier =
            Modifier.size(28.dp)
                .background(bgColor, shape = RoundedCornerShape(6.dp))
                .then(
                    if (borderColor != Color.Transparent)
                        Modifier.border(1.5.dp, borderColor, RoundedCornerShape(6.dp))
                    else Modifier
                )
                .clickable(onClick = onClick)
                .pointerHoverIcon(PointerIcon.Hand),
        contentAlignment = Alignment.Center,
    ) {
      // Simple device icon representation
      when (device.type) {
        DeviceType.AndroidEmulator -> AndroidDeviceIcon(color = iconColor)
        DeviceType.iOSSimulator -> AppleDeviceIcon(color = iconColor)
      }
    }
  }
}

@Composable
private fun AndroidDeviceIcon(color: Color) {
  // Simple Android robot head shape
  Box(modifier = Modifier.size(16.dp)) {
    // Body (rounded rectangle)
    Box(
        modifier =
            Modifier.align(Alignment.BottomCenter)
                .size(width = 12.dp, height = 10.dp)
                .background(color, RoundedCornerShape(topStart = 2.dp, topEnd = 2.dp, bottomStart = 3.dp, bottomEnd = 3.dp))
    )
    // Head (smaller rounded rect on top)
    Box(
        modifier =
            Modifier.align(Alignment.TopCenter)
                .offset(y = 1.dp)
                .size(width = 10.dp, height = 5.dp)
                .background(color, RoundedCornerShape(topStart = 3.dp, topEnd = 3.dp))
    )
  }
}

@Composable
private fun AppleDeviceIcon(color: Color) {
  // Simple iPhone shape (rounded rectangle with notch hint)
  Box(
      modifier =
          Modifier.size(width = 10.dp, height = 16.dp)
              .background(color, RoundedCornerShape(2.dp))
  )
}

@Composable
private fun LiveToggle(isLive: Boolean, onToggle: (Boolean) -> Unit) {
  val colors = JewelTheme.globalColors
  val trackColor =
      if (isLive) Color(0xFF4CAF50).copy(alpha = 0.4f)
      else colors.text.normal.copy(alpha = 0.2f)
  val thumbColor =
      if (isLive) Color(0xFF4CAF50)
      else colors.text.normal.copy(alpha = 0.5f)

  Box(
      modifier =
          Modifier.size(width = 32.dp, height = 18.dp)
              .background(trackColor, shape = RoundedCornerShape(9.dp))
              .clickable { onToggle(!isLive) }
              .pointerHoverIcon(PointerIcon.Hand),
  ) {
    Box(
        modifier =
            Modifier.padding(2.dp)
                .size(14.dp)
                .align(if (isLive) Alignment.CenterEnd else Alignment.CenterStart)
                .background(thumbColor, shape = CircleShape),
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
