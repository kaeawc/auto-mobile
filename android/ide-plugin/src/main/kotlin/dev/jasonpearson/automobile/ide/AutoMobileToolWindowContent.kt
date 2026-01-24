@file:OptIn(ExperimentalFoundationApi::class)

package dev.jasonpearson.automobile.ide

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
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
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.jetbrains.jewel.foundation.theme.JewelTheme
import org.jetbrains.jewel.ui.component.Link
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.component.Tooltip
import dev.jasonpearson.automobile.ide.layout.LayoutInspectorDashboard
import dev.jasonpearson.automobile.ide.navigation.NavigationDashboard
import dev.jasonpearson.automobile.ide.performance.PerformanceDashboard
import dev.jasonpearson.automobile.ide.test.TestDashboard

enum class Dashboard(val title: String) {
  Navigation("Navigation"),
  Test("Test"),
  Performance("Performance"),
  Layout("Layout"),
  Storage("Storage"),
  Reliability("Reliability"),
}

// Reliability Dashboard sections
enum class ReliabilitySection { Overview, FailureDetail }

// Storage Dashboard sections
enum class StorageSection { Overview, DatabaseInspector, SharedPrefs }

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
  val dashboardOrder = remember { mutableStateListOf(*Dashboard.entries.toTypedArray()) }
  var draggedIndex by remember { mutableStateOf<Int?>(null) }
  var dropTargetIndex by remember { mutableStateOf<Int?>(null) }

  // Mock booted devices - will be replaced with real data
  var activeDeviceId by remember { mutableStateOf("pixel8") }
  val bootedDevices = remember {
    listOf(
        BootedDevice("pixel8", "Pixel 8 API 35", DeviceType.AndroidEmulator, "Running", "com.example.myapp"),
        BootedDevice("pixel7", "Pixel 7 API 34", DeviceType.AndroidEmulator, "Running", "com.android.launcher3"),
        BootedDevice("iphone15", "iPhone 15 Pro", DeviceType.iOSSimulator, "Booted", "com.apple.springboard"),
    )
  }

  // Test flow replay state
  var testFlowScreens by remember { mutableStateOf<List<String>>(emptyList()) }
  var currentReplayIndex by remember { mutableIntStateOf(0) }
  var isReplaying by remember { mutableStateOf(false) }

  // Animate through the test flow screens
  androidx.compose.runtime.LaunchedEffect(isReplaying, testFlowScreens) {
    if (isReplaying && testFlowScreens.isNotEmpty()) {
      currentReplayIndex = 0
      while (isReplaying && currentReplayIndex < testFlowScreens.size) {
        kotlinx.coroutines.delay(800)  // Show each screen for 800ms
        if (currentReplayIndex < testFlowScreens.size - 1) {
          currentReplayIndex++
        } else {
          // Reached end - restart or stop
          kotlinx.coroutines.delay(1000)  // Pause at end
          currentReplayIndex = 0  // Loop back
        }
      }
    }
  }

  // Compute the current highlighted screens for replay (show path up to current index)
  val replayHighlightedScreens = remember(testFlowScreens, currentReplayIndex, isReplaying) {
    if (isReplaying && testFlowScreens.isNotEmpty()) {
      testFlowScreens.take(currentReplayIndex + 1)
    } else {
      testFlowScreens
    }
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

    // Dashboard Tabs with drag-and-drop reordering
    DraggableTabs(
        tabs = dashboardOrder,
        selectedIndex = selectedIndex,
        onTabSelected = { selectedIndex = it },
        onReorder = { fromIndex, toIndex ->
            val item = dashboardOrder.removeAt(fromIndex)
            dashboardOrder.add(toIndex, item)
            // Adjust selected index if needed
            when {
                fromIndex == selectedIndex -> selectedIndex = toIndex
                fromIndex < selectedIndex && toIndex >= selectedIndex -> selectedIndex--
                fromIndex > selectedIndex && toIndex <= selectedIndex -> selectedIndex++
            }
        },
        draggedIndex = draggedIndex,
        onDragStart = { draggedIndex = it },
        onDragEnd = { draggedIndex = null; dropTargetIndex = null },
        dropTargetIndex = dropTargetIndex,
        onDropTargetChanged = { dropTargetIndex = it },
    )

    // Dashboard Content
    when (dashboardOrder[selectedIndex]) {
      Dashboard.Navigation -> NavigationDashboard(
          highlightedScreens = replayHighlightedScreens,
          onHighlightCleared = {
              testFlowScreens = emptyList()
              isReplaying = false
          },
      )
      Dashboard.Test -> TestDashboard(
          onOpenFile = { filePath ->
              // TODO: Open file in IDE editor
          },
          onNavigateToGraph = { screens ->
              // Set up test flow replay
              testFlowScreens = screens
              isReplaying = true
              currentReplayIndex = 0
              selectedIndex = 0  // Switch to Navigation tab
          },
      )
      Dashboard.Performance -> PerformanceDashboard(
          onNavigateToScreen = { screenName ->
              // Switch to Navigation tab and highlight the screen
              selectedIndex = 0
          },
          onNavigateToTest = { testName ->
              // Switch to Test tab
              selectedIndex = 1
          },
      )
      Dashboard.Layout -> LayoutInspectorDashboard()
      Dashboard.Storage -> Box(Modifier.fillMaxSize().padding(16.dp)) { StorageDashboard() }
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
private fun DraggableTabs(
    tabs: List<Dashboard>,
    selectedIndex: Int,
    onTabSelected: (Int) -> Unit,
    onReorder: (fromIndex: Int, toIndex: Int) -> Unit,
    draggedIndex: Int?,
    onDragStart: (Int) -> Unit,
    onDragEnd: () -> Unit,
    dropTargetIndex: Int?,
    onDropTargetChanged: (Int?) -> Unit,
) {
    val colors = JewelTheme.globalColors
    var tabPositions by remember { mutableStateOf<Map<Int, Float>>(emptyMap()) }
    var dragOffset by remember { mutableStateOf(0f) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.text.normal.copy(alpha = 0.03f))
            .padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.Start,
    ) {
        tabs.forEachIndexed { index, dashboard ->
            val isSelected = index == selectedIndex
            val isDragged = index == draggedIndex
            val isDropTarget = index == dropTargetIndex && draggedIndex != null && draggedIndex != index

            Box(
                modifier = Modifier
                    .padding(vertical = 4.dp, horizontal = 2.dp)
                    .then(
                        if (isDragged) Modifier.offset(x = dragOffset.dp)
                        else Modifier
                    )
                    .background(
                        when {
                            isDropTarget -> colors.text.normal.copy(alpha = 0.15f)
                            isSelected -> colors.text.normal.copy(alpha = 0.1f)
                            else -> Color.Transparent
                        },
                        RoundedCornerShape(6.dp)
                    )
                    .then(
                        if (isDropTarget)
                            Modifier.border(1.5.dp, Color(0xFF2196F3).copy(alpha = 0.5f), RoundedCornerShape(6.dp))
                        else Modifier
                    )
                    .clickable { onTabSelected(index) }
                    .pointerInput(index) {
                        detectDragGesturesAfterLongPress(
                            onDragStart = { onDragStart(index) },
                            onDragEnd = {
                                if (draggedIndex != null && dropTargetIndex != null && draggedIndex != dropTargetIndex) {
                                    onReorder(draggedIndex, dropTargetIndex)
                                }
                                dragOffset = 0f
                                onDragEnd()
                            },
                            onDragCancel = {
                                dragOffset = 0f
                                onDragEnd()
                            },
                            onDrag = { change, dragAmount ->
                                change.consume()
                                dragOffset += dragAmount.x / 2  // Scale down for smoother feel

                                // Calculate which tab we're over based on position
                                val positions = tabPositions.toList().sortedBy { it.second }
                                val draggedPos = (tabPositions[index] ?: 0f) + dragOffset
                                var newTarget: Int? = null
                                for (i in positions.indices) {
                                    val (tabIdx, pos) = positions[i]
                                    val nextPos = positions.getOrNull(i + 1)?.second ?: (pos + 80f)
                                    if (draggedPos >= pos && draggedPos < nextPos) {
                                        newTarget = tabIdx
                                        break
                                    }
                                }
                                if (newTarget != null && newTarget != draggedIndex) {
                                    onDropTargetChanged(newTarget)
                                } else if (newTarget == draggedIndex) {
                                    onDropTargetChanged(null)
                                }
                            }
                        )
                    }
                    .pointerHoverIcon(PointerIcon.Hand)
                    .padding(horizontal = 12.dp, vertical = 6.dp)
                    .onGloballyPositioned { coordinates ->
                        tabPositions = tabPositions + (index to coordinates.positionInParent().x)
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    dashboard.title,
                    fontSize = 12.sp,
                    color = when {
                        isDragged -> colors.text.normal.copy(alpha = 0.8f)
                        isSelected -> colors.text.normal
                        else -> colors.text.normal.copy(alpha = 0.6f)
                    },
                )
            }
        }
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

@Composable
private fun StorageDashboard() {
  var currentSection by remember { mutableStateOf(StorageSection.Overview) }

  when (currentSection) {
    StorageSection.Overview ->
        DashboardOverview(
            title = "Storage",
            description = "Inspect and manage app data storage.",
            sections =
                listOf(
                    SectionItem("Database Inspector", "Browse and query SQLite databases") {
                      currentSection = StorageSection.DatabaseInspector
                    },
                    SectionItem("SharedPreferences", "View and edit preference files") {
                      currentSection = StorageSection.SharedPrefs
                    },
                ),
        )
    StorageSection.DatabaseInspector ->
        SectionDetail(
            title = "Database Inspector",
            description = "Browse and query SQLite databases.",
            features =
                listOf(
                    "Table browser",
                    "SQL query console",
                    "Schema viewer",
                    "Real-time updates",
                    "Export data",
                ),
            onBack = { currentSection = StorageSection.Overview },
        )
    StorageSection.SharedPrefs ->
        SectionDetail(
            title = "SharedPreferences",
            description = "View and edit preference files.",
            features =
                listOf(
                    "Key-value browser",
                    "Live editing",
                    "Type support (String, Int, Boolean, etc.)",
                    "Search and filter",
                ),
            onBack = { currentSection = StorageSection.Overview },
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
