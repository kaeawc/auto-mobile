package dev.jasonpearson.automobile.desktop.core.test

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
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
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.components.Link
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceGestureRecordingClient
import dev.jasonpearson.automobile.desktop.core.daemon.HierarchyStreamUpdate
import dev.jasonpearson.automobile.desktop.core.daemon.NavigationGraphStreamUpdate
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.daemon.ScreenshotStreamUpdate
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.formatUiNumber
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.mcp.BootedDevice
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceType
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.jetbrains.skia.Image

private val LOG = LoggerFactory.getLogger("TestDashboard")

enum class TestScreen {
  Dashboard,
  RecordingTest,
  ModuleSelection,
  TestRunDetail,
}

data class TestDashboardOptions(
  val onOpenFile: (String) -> Unit = {},
  val onNavigateToGraph: (List<String>) -> Unit = {},
  val dataSourceMode: DataSourceMode = DataSourceMode.Fake,
  val clientProvider: (() -> AutoMobileClient)? = null,
  val observationStreamClient: ObservationStreamClient? = null,
  val deviceGestureRecordingClient: DeviceGestureRecordingClient? = null,
  val ioDispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.IO,
  val fileSaver: dev.jasonpearson.automobile.desktop.core.platform.FileSaver =
    dev.jasonpearson.automobile.desktop.core.platform.SwingFileSaver,
)

@Composable
fun TestDashboard(options: TestDashboardOptions = TestDashboardOptions()) {
  val state = remember { TestDashboardState() }
  ClearTestNavigation(options, state)
  CollectTestHierarchy(options, state)
  CollectTestScreenshots(options, state)
  CollectTestNavigation(options, state)
  LoadTestDashboardRuns(options, state)
  TestDashboardScreen(options, state)
}

private enum class TestFilter {
  Recent,
  Popular,
  Both,
}

@Composable
internal fun TestDashboardHome(
  testRuns: List<TestRun>,
  isLoading: Boolean = false,
  error: String? = null,
  onRecordTest: () -> Unit,
  onTestRunClick: (TestRun) -> Unit,
) {
  val colors = SharedTheme.globalColors
  val scrollState = rememberScrollState()
  var selectedFilter by remember { mutableStateOf(TestFilter.Both) }

  // Sort based on filter - use sampleSize for popularity (fallback to TestMockData for fake data)
  val sortedRuns =
    remember(selectedFilter, testRuns) { sortDashboardRuns(selectedFilter, testRuns) }

  Column(modifier = Modifier.fillMaxSize().verticalScroll(scrollState).padding(16.dp)) {
    Text("Testing", fontSize = 18.sp)
    Text(
      "Create, run, and analyze UI tests",
      color = colors.text.normal.copy(alpha = 0.6f),
      fontSize = 12.sp,
      modifier = Modifier.padding(top = 4.dp),
    )

    Spacer(Modifier.height(20.dp))

    // TODO: Once we have a proper device gesture recording flow, make this button available again
    // Button(onClick = onRecordTest) { Text("Record Test") }

    Spacer(Modifier.height(24.dp))

    // Test Runs header with filter chips
    TestRunFilterHeader(selectedFilter) { selectedFilter = it }

    Spacer(Modifier.height(8.dp))

    TestRunList(sortedRuns, isLoading, error, onTestRunClick)
  }
}

@Composable
private fun FilterChip(
  label: String,
  selected: Boolean,
  onClick: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  val bgColor = if (selected) colors.text.normal.copy(alpha = 0.15f) else Color.Transparent
  val borderColor =
    if (selected) colors.text.normal.copy(alpha = 0.3f) else colors.text.normal.copy(alpha = 0.15f)
  val textColor = if (selected) colors.text.normal else colors.text.normal.copy(alpha = 0.6f)

  Box(
    modifier =
      Modifier.border(1.dp, borderColor, RoundedCornerShape(12.dp))
        .background(bgColor, RoundedCornerShape(12.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 10.dp, vertical = 4.dp),
  ) {
    Text(label, fontSize = 11.sp, color = textColor)
  }
}

@Composable
private fun TestRunRowEnhanced(
  run: TestRun,
  runCount: Int,
  flakinessScore: Float,
  onClick: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  val statusColor =
    when (run.status) {
      TestStatus.Passed -> Color(0xFF4CAF50)
      TestStatus.Failed -> Color(0xFFFF5722)
      TestStatus.Running -> Color(0xFF2196F3)
      TestStatus.Skipped -> colors.text.normal.copy(alpha = 0.4f)
    }

  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.04f), RoundedCornerShape(6.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(12.dp),
    horizontalArrangement = Arrangement.SpaceBetween,
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Row(
      horizontalArrangement = Arrangement.spacedBy(10.dp),
      verticalAlignment = Alignment.CenterVertically,
      modifier = Modifier.weight(1f),
    ) {
      Box(modifier = Modifier.size(8.dp).background(statusColor, CircleShape))
      Column {
        Text(run.testName, fontSize = 13.sp)
        // Show steps if available, otherwise show sample count as "runs"
        val detailText =
          if (run.steps.isNotEmpty()) {
            "${run.deviceName} • ${run.steps.size} steps • $runCount runs"
          } else {
            "${run.deviceName} • $runCount runs"
          }
        Text(
          detailText,
          fontSize = 11.sp,
          color = colors.text.normal.copy(alpha = 0.5f),
        )
      }
    }

    RunTimingAndFlakiness(run, flakinessScore)
  }
}

@Composable
private fun SuggestedPromptChip(
  text: String,
  onClick: () -> Unit,
) {
  val colors = SharedTheme.globalColors

  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
        .border(1.dp, colors.text.normal.copy(alpha = 0.08f), RoundedCornerShape(6.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 10.dp, vertical = 8.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      "+",
      fontSize = 14.sp,
      color = colors.text.normal.copy(alpha = 0.4f),
    )
    Text(
      text,
      fontSize = 11.sp,
      color = colors.text.normal.copy(alpha = 0.7f),
    )
  }
}

private enum class RecordingPhase {
  Setup,
  Recording,
  Reviewing,
}

private data class RecordingTestOptions(
  val ioDispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.IO,
  val mainDispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.Main,
  val recordedActions: List<RecordedAction>,
  val onActionRecorded: (RecordedAction) -> Unit,
  val onFinishRecording: () -> Unit,
  val onBack: () -> Unit,
  val screenshotUpdate: ScreenshotStreamUpdate? = null,
  val hierarchyUpdate: HierarchyStreamUpdate? = null,
  val navigationUpdate: NavigationGraphStreamUpdate? = null,
  val deviceGestureRecordingClient: DeviceGestureRecordingClient? = null,
  val fileSaver: dev.jasonpearson.automobile.desktop.core.platform.FileSaver =
    dev.jasonpearson.automobile.desktop.core.platform.SwingFileSaver,
)

@Composable
private fun RecordingTestScreen(options: RecordingTestOptions) {
  val state = remember { RecordingSessionState() }
  val coroutineScope = rememberCoroutineScope()
  LaunchedEffect(Unit) {
    kotlinx.coroutines.delay(1500)
    state.isLoadingAnalysis = false
  }
  val screenshotBytes = rememberRecordingScreenshot(options.screenshotUpdate)
  val context = RecordingContext(options, state, coroutineScope, screenshotBytes)
  when (state.recordingPhase) {
    RecordingPhase.Setup -> RecordingSetup(context)
    RecordingPhase.Recording -> RecordingActive(context)
    RecordingPhase.Reviewing -> RecordingReview(context)
  }
}

@Composable
private fun PlanReviewPanel(
  plan: ExportedPlan,
  onSave: () -> Unit,
  onCopy: () -> Unit,
  onDismiss: () -> Unit,
  fileSaver: dev.jasonpearson.automobile.desktop.core.platform.FileSaver =
    dev.jasonpearson.automobile.desktop.core.platform.SwingFileSaver,
) {
  val colors = SharedTheme.globalColors
  val scrollState = rememberScrollState()
  var saveSuccess by remember { mutableStateOf<String?>(null) }
  var copySuccess by remember { mutableStateOf(false) }

  // Reset copy success after a delay
  LaunchedEffect(copySuccess) {
    if (copySuccess) {
      kotlinx.coroutines.delay(2000)
      copySuccess = false
    }
  }

  Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
    // Header
    Link("← Back to Dashboard", onClick = onDismiss)
    Spacer(Modifier.height(12.dp))

    Text("Plan Review", fontSize = 18.sp)
    Text(
      plan.planName,
      color = colors.text.normal.copy(alpha = 0.6f),
      fontSize = 12.sp,
      modifier = Modifier.padding(top = 4.dp),
    )
    Text(
      "${plan.stepCount} steps \u2022 ${plan.durationMs / 1000.0}s duration",
      color = colors.text.normal.copy(alpha = 0.5f),
      fontSize = 11.sp,
      modifier = Modifier.padding(top = 2.dp),
    )

    Spacer(Modifier.height(16.dp))

    PlanYamlViewer(plan.planContent, scrollState, Modifier.weight(1f))
    Spacer(Modifier.height(16.dp))

    PlanReviewButtons(
      saveSuccess,
      copySuccess,
      onSave = {
        savePlanToFile(
          plan,
          fileSaver,
        ) { path ->
          saveSuccess = path
        }
        onSave()
      },
      onCopy = {
        copyPlanToClipboard(plan.planContent)
        copySuccess = true
        onCopy()
      },
      onDismiss = onDismiss,
    )
  }
}

/**
 * Applies syntax highlighting to YAML content using AnnotatedString.
 * - Keys (before `:`) - cyan
 * - String values (in quotes) - green
 * - Numbers - orange
 * - Tool names - magenta
 * - Comments (#) - gray
 */
private fun savePlanToFile(
  plan: ExportedPlan,
  fileSaver: dev.jasonpearson.automobile.desktop.core.platform.FileSaver,
  onError: (Throwable) -> Unit = {
    LOG.warn("Failed to save plan '${plan.planName}': ${it.message}")
  },
  onSuccess: (String) -> Unit,
) {
  fileSaver.save("${plan.planName}.yaml", plan.planContent, onSuccess, onError)
}

private fun copyPlanToClipboard(content: String) {
  try {
    val clipboard = java.awt.Toolkit.getDefaultToolkit().systemClipboard
    clipboard.setContents(java.awt.datatransfer.StringSelection(content), null)
  } catch (e: java.awt.HeadlessException) {
    LOG.warn("Test dashboard operation failed", e)

    LOG.warn("Failed to copy to clipboard", e)
  } catch (cancellation: kotlinx.coroutines.CancellationException) {
    throw cancellation
  } catch (e: IllegalStateException) {
    LOG.warn("Test dashboard operation failed", e)

    LOG.warn("Failed to copy to clipboard", e)
  } catch (e: SecurityException) {
    LOG.warn("Test dashboard operation failed", e)

    LOG.warn("Failed to copy to clipboard", e)
  }
}

@Composable
private fun ModuleSelectionScreen(
  recordedActions: List<RecordedAction>,
  onModuleSelected: (GradleModule) -> Unit,
  onBack: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  var searchText by remember { mutableStateOf("") }

  val filteredModules =
    remember(searchText) {
      val query = searchText
      if (query.isBlank()) {
        TestMockData.modules
      } else {
        TestMockData.modules.filter {
          it.name.contains(query, ignoreCase = true) || it.path.contains(query, ignoreCase = true)
        }
      }
    }

  Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
    Link("← Back to Recording", onClick = onBack)
    Spacer(Modifier.height(12.dp))

    Text("Select Module", fontSize = 18.sp)
    Text(
      "Choose which module to save the test plan in",
      color = colors.text.normal.copy(alpha = 0.6f),
      fontSize = 12.sp,
      modifier = Modifier.padding(top = 4.dp),
    )

    Spacer(Modifier.height(8.dp))

    Text(
      "${recordedActions.size} actions recorded",
      fontSize = 12.sp,
      color = Color(0xFF4CAF50),
    )

    Spacer(Modifier.height(16.dp))

    // Search field
    TextField(
      value = searchText,
      onValueChange = { searchText = it },
      modifier = Modifier.fillMaxWidth(),
    )

    Spacer(Modifier.height(12.dp))

    // Module list
    Column(
      modifier = Modifier.verticalScroll(rememberScrollState()),
      verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      filteredModules.forEach { module ->
        ModuleSelectionRow(module, onModuleSelected)
      }
    }
  }
}

// Data class for historical run records
private data class HistoricalRun(
  val runId: String?, // null if no record exists (just pass/fail indicator)
  val passed: Boolean,
)

@Composable
private fun TestRunDetailScreen(
  testRun: TestRun,
  allTestRuns: List<TestRun> = emptyList(),
  onBack: () -> Unit,
  onViewInGraph: () -> Unit,
  onNavigateToRun: (String) -> Unit = {}, // Navigate to another test run by ID
) {
  val playback = remember { DetailPlaybackState() }
  with(playback) {
    val scrollState = rememberScrollState()

    // Video playback state

    // Calculate cumulative timestamps for each step
    val stepTimestamps =
      remember(testRun.steps) {
        var cumulative = 0L
        testRun.steps.map { step ->
          val start = cumulative
          cumulative += step.durationMs
          start to cumulative
        }
      }

    // Determine current step based on playback time
    val currentStepIndex =
      remember(playbackTimeMs, stepTimestamps) {
        stepTimestamps.indexOfLast { (start, _) -> playbackTimeMs >= start }.coerceAtLeast(0)
      }

    // Animate playback when playing
    ObserveDetailPlayback(testRun, playback)

    // Historical runs for the same test, sorted by start time
    val historicalRuns =
      remember(testRun.testId, allTestRuns) {
        allTestRuns
          .filter { it.testId == testRun.testId }
          .sortedBy { it.startTime }
          .takeLast(10) // Show last 10 runs
          .map { run ->
            HistoricalRun(
              runId = run.id,
              passed = run.status == TestStatus.Passed,
            )
          }
          .ifEmpty {
            // Fallback: just show the current run if no history
            listOf(HistoricalRun(testRun.id, testRun.status == TestStatus.Passed))
          }
      }
    val passRate =
      if (historicalRuns.isNotEmpty()) {
        (historicalRuns.count { it.passed } * 100) / historicalRuns.size
      } else 0

    val context =
      DetailRunContext(
        testRun,
        playback,
        stepTimestamps,
        currentStepIndex,
        historicalRuns,
        passRate,
        DetailRunActions(onBack, onViewInGraph, onNavigateToRun),
      )
    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
      val isWideLayout = maxWidth >= 400.dp

      TestRunDetailContent(context, scrollState, isWideLayout)
    }
  }
}

@Composable
private fun RunHistoryChart(
  historicalRuns: List<HistoricalRun>,
  passRate: Int,
  currentRunId: String,
  onRunClick: (String?) -> Unit,
  isCompact: Boolean,
) {
  val colors = SharedTheme.globalColors

  Column {
    Text("Run History", fontSize = 12.sp, color = colors.text.normal.copy(alpha = 0.6f))
    Spacer(Modifier.height(6.dp))

    // Chart with pass rate overlay
    Box(
      modifier =
        Modifier.fillMaxWidth()
          .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
          .padding(8.dp),
    ) {
      Row(
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth(),
      ) {
        historicalRuns.forEach { run ->
          val isCurrentRun = run.runId == currentRunId
          val isClickable = run.runId != null && !isCurrentRun
          val barColor =
            when {
              isCurrentRun -> Color(0xFF2196F3) // Blue for current
              run.passed -> Color(0xFF4CAF50)
              else -> Color(0xFFFF5722)
            }

          Box(
            modifier =
              Modifier.weight(1f)
                .height(20.dp)
                .background(barColor, RoundedCornerShape(2.dp))
                .then(
                  if (isCurrentRun)
                    Modifier.border(
                      1.dp,
                      Color.White.copy(alpha = 0.5f),
                      RoundedCornerShape(2.dp),
                    )
                  else Modifier,
                )
                .then(
                  if (isClickable)
                    Modifier.clickable { onRunClick(run.runId) }.pointerHoverIcon(PointerIcon.Hand)
                  else Modifier,
                ),
          )
        }

        // Pass rate inside the chart area
        Spacer(Modifier.width(8.dp))
        Text(
          "$passRate%",
          fontSize = 12.sp,
          color = colors.text.normal.copy(alpha = 0.7f),
        )
      }
    }
  }
}

@Composable
private fun VideoPlayerWithTimeline(
  testRun: TestRun,
  currentStepIndex: Int,
  playbackTimeMs: Long,
  stepTimestamps: List<Pair<Long, Long>>,
) {
  Column {
    VideoPlaybackDisplay(testRun, playbackTimeMs)
    Spacer(Modifier.height(8.dp))
    VideoPlaybackProgress(testRun, currentStepIndex, playbackTimeMs, stepTimestamps)
    Spacer(Modifier.height(4.dp))
    VideoPlaybackLinks(testRun, playbackTimeMs)
  }
}

@Composable
private fun RelatedTestsSection(
  testRun: TestRun,
  isCompact: Boolean,
) {
  val colors = SharedTheme.globalColors

  val relatedTests =
    remember(testRun) {
      TestMockData.testCases
        .filter { test ->
          test.id != testRun.testId && test.screensVisited.any { it in testRun.screensVisited }
        }
        .take(3)
        .map { test ->
          val sharedScreens = test.screensVisited.filter { it in testRun.screensVisited }
          Triple(test.name, sharedScreens, test.flakinessScore)
        }
    }

  Text("Related Tests", fontSize = 12.sp, color = colors.text.normal.copy(alpha = 0.6f))
  Spacer(Modifier.height(6.dp))

  if (relatedTests.isEmpty()) {
    Text(
      "No related tests found",
      fontSize = 11.sp,
      color = colors.text.normal.copy(alpha = 0.4f),
    )
  } else {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
      relatedTests.forEach { (name, sharedScreens, flakiness) ->
        RelatedTestRow(name, sharedScreens, flakiness, isCompact)
      }
    }
  }
}

private data class ActionCardOptions(
  val icon: String,
  val title: String,
  val description: String,
  val onClick: () -> Unit,
  val modifier: Modifier = Modifier,
  val emphasized: Boolean = false,
)

@Composable
private fun ActionCard(options: ActionCardOptions) {
  val icon = options.icon
  val title = options.title
  val description = options.description
  val onClick = options.onClick
  val modifier = options.modifier
  val emphasized = options.emphasized

  val colors = SharedTheme.globalColors
  val bgColor =
    if (emphasized) {
      Color(0xFF2196F3).copy(alpha = 0.1f)
    } else {
      colors.text.normal.copy(alpha = 0.05f)
    }
  val borderColor =
    if (emphasized) {
      Color(0xFF2196F3).copy(alpha = 0.3f)
    } else {
      Color.Transparent
    }

  Box(
    modifier =
      modifier
        .then(
          if (borderColor != Color.Transparent)
            Modifier.border(1.dp, borderColor, RoundedCornerShape(8.dp))
          else Modifier,
        )
        .background(bgColor, RoundedCornerShape(8.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(12.dp),
  ) {
    Row(
      horizontalArrangement = Arrangement.spacedBy(10.dp),
      verticalAlignment = Alignment.Top,
    ) {
      Text(icon, fontSize = 20.sp)
      Column {
        Text(title, fontSize = 13.sp)
        Text(
          description,
          fontSize = 11.sp,
          color = colors.text.normal.copy(alpha = 0.5f),
        )
      }
    }
  }
}

@Composable
private fun DevicePickerOverlay(
  platform: TestPlatform,
  onDeviceSelected: (BootedDevice) -> Unit,
  onDismiss: () -> Unit,
) {
  val colors = SharedTheme.globalColors

  // Mock devices - would come from actual device manager
  // Filter to only show devices matching the test platform
  val allDevices = remember {
    listOf(
      BootedDevice("pixel8", "Pixel 8 API 35", DeviceType.AndroidEmulator, "Running"),
      BootedDevice("pixel7", "Pixel 7 API 34", DeviceType.AndroidEmulator, "Running"),
      BootedDevice("iphone15", "iPhone 15 Pro", DeviceType.iOSSimulator, "Booted"),
      BootedDevice("iphone14", "iPhone 14", DeviceType.iOSSimulator, "Booted"),
    )
  }

  val availableDevices =
    remember(platform) {
      allDevices.filter { device ->
        when (platform) {
          TestPlatform.Android -> device.type == DeviceType.AndroidEmulator
          TestPlatform.iOS -> device.type == DeviceType.iOSSimulator
        }
      }
    }

  val platformName = if (platform == TestPlatform.Android) "Android Emulator" else "iOS Simulator"

  Box(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(8.dp))
        .border(1.dp, colors.text.normal.copy(alpha = 0.1f), RoundedCornerShape(8.dp))
        .padding(12.dp),
  ) {
    Column {
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text("Select $platformName", fontSize = 13.sp)
        Link("Cancel", onClick = onDismiss)
      }

      Spacer(Modifier.height(12.dp))

      availableDevices.forEach { device ->
        DevicePickerRow(
          device = device,
          onClick = { onDeviceSelected(device) },
        )
        Spacer(Modifier.height(6.dp))
      }
    }
  }
}

@Composable
private fun DevicePickerRow(
  device: BootedDevice,
  onClick: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  val iconColor = colors.text.normal.copy(alpha = 0.7f)

  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(6.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(10.dp),
    horizontalArrangement = Arrangement.spacedBy(10.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    // Device type icon
    Text(
      when (device.type) {
        DeviceType.AndroidEmulator,
        DeviceType.AndroidPhysical -> "🤖"
        DeviceType.iOSSimulator,
        DeviceType.iOSPhysical -> "🍎"
      },
      fontSize = 16.sp,
    )

    Column(modifier = Modifier.weight(1f)) {
      Text(device.name, fontSize = 12.sp)
      Text(
        device.status,
        fontSize = 10.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
      )
    }

    // Status indicator
    Box(modifier = Modifier.size(8.dp).background(Color(0xFF4CAF50), CircleShape))
  }
}

private fun formatTime(ms: Long): String {
  val seconds = (ms / 1000) % 60
  val minutes = (ms / 1000) / 60
  val millis = (ms % 1000) / 10
  return if (minutes > 0) {
    formatUiNumber("%d:%02d.%02d", minutes, seconds, millis)
  } else {
    formatUiNumber("%d.%02ds", seconds, millis)
  }
}

@Composable
private fun TestStepRowWithScreenshot(
  step: TestStep,
  isCurrentStep: Boolean,
  onStepClick: () -> Unit,
  isCompact: Boolean = false,
) {
  val colors = SharedTheme.globalColors
  val statusColor =
    when (step.status) {
      TestStatus.Passed -> Color(0xFF4CAF50)
      TestStatus.Failed -> Color(0xFFFF5722)
      TestStatus.Running -> Color(0xFF2196F3)
      TestStatus.Skipped -> colors.text.normal.copy(alpha = 0.4f)
    }

  val highlightColor =
    if (isCurrentStep) Color(0xFF2196F3).copy(alpha = 0.15f)
    else colors.text.normal.copy(alpha = 0.03f)

  val borderModifier =
    if (isCurrentStep) {
      Modifier.border(1.5.dp, Color(0xFF2196F3).copy(alpha = 0.6f), RoundedCornerShape(6.dp))
    } else Modifier

  Row(
    modifier =
      Modifier.fillMaxWidth()
        .then(borderModifier)
        .background(highlightColor, RoundedCornerShape(6.dp))
        .clickable(onClick = onStepClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(if (isCompact) 8.dp else 10.dp),
    verticalAlignment = Alignment.Top,
  ) {
    StepScreenshotThumbnail(step, isCompact)

    StepDetails(step, isCurrentStep, isCompact, statusColor, Modifier.weight(1f))

    // Duration only (removed ">" indicator)
    Text(
      "${step.durationMs}ms",
      fontSize = if (isCompact) 9.sp else 10.sp,
      color = colors.text.normal.copy(alpha = 0.4f),
    )
  }
}

@Composable
private fun ArtifactButton(label: String) {
  val colors = SharedTheme.globalColors

  Box(
    modifier =
      Modifier.background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(6.dp))
        .clickable { /* TODO: Open artifact */ }
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 12.dp, vertical = 8.dp),
  ) {
    Text(label, fontSize = 12.sp)
  }
}

// Cache for extracted video frames to avoid repeated ffmpeg calls
private val frameCache = mutableMapOf<String, org.jetbrains.skia.Image?>()

/**
 * Extract a frame from the video at the specified time using ffmpeg. Returns null if extraction
 * fails or ffmpeg is not available.
 */
private fun extractVideoFrame(videoPath: String, timeMs: Long): org.jetbrains.skia.Image? {
  // Create cache key based on video path and time (rounded to nearest 500ms for efficiency)
  val roundedTimeMs = (timeMs / 500) * 500
  val cacheKey = "$videoPath:$roundedTimeMs"

  // Return cached frame if available
  frameCache[cacheKey]?.let {
    return it
  }

  // Limit cache size
  if (frameCache.size > 100) {
    frameCache.clear()
  }

  return try {
    val file = java.io.File(videoPath)
    if (!file.exists()) {
      frameCache[cacheKey] = null
      return null
    }

    // Convert time to ffmpeg format (HH:MM:SS.mmm)
    val seconds = timeMs / 1000.0
    val timeStr = String.format(Locale.ROOT, "%.3f", seconds)

    // Create temp file for the extracted frame
    val tempFile = java.io.File.createTempFile("video_frame_", ".png")
    tempFile.deleteOnExit()

    // Use ffmpeg to extract a single frame
    val process =
      ProcessBuilder(
          "ffmpeg",
          "-ss",
          timeStr,
          "-i",
          videoPath,
          "-vframes",
          "1",
          "-y",
          tempFile.absolutePath,
        )
        .redirectErrorStream(true)
        .start()

    val exitCode = process.waitFor()
    if (exitCode != 0 || !tempFile.exists() || tempFile.length() == 0L) {
      tempFile.delete()
      frameCache[cacheKey] = null
      return null
    }

    // Load the image using Skia
    val imageBytes = tempFile.readBytes()
    tempFile.delete()

    val image = org.jetbrains.skia.Image.makeFromEncoded(imageBytes)
    frameCache[cacheKey] = image
    image
  } catch (e: java.io.IOException) {
    cacheFrameFailure(cacheKey, e)
  } catch (e: InterruptedException) {
    cacheFrameFailure(cacheKey, e)
  } catch (e: IllegalArgumentException) {
    cacheFrameFailure(cacheKey, e)
  } catch (e: SecurityException) {
    cacheFrameFailure(cacheKey, e)
  }
}

@Composable
private fun RunTimingAndFlakiness(run: TestRun, flakinessScore: Float) {
  val colors = SharedTheme.globalColors
  Column(horizontalAlignment = Alignment.End) {
    Text(
      "${run.durationMs / 1000.0}s",
      fontSize = 11.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
    )
    if (flakinessScore > 0.1f) {
      Text(
        "${(flakinessScore * 100).toInt()}% flaky",
        fontSize = 10.sp,
        color = Color(0xFFFFC107),
      )
    } else if (run.status == TestStatus.Failed) {
      Text(
        "Failed",
        fontSize = 10.sp,
        color = Color(0xFFFF5722),
      )
    }
  }
}

@Composable
private fun ModuleSelectionRow(module: GradleModule, onModuleSelected: (GradleModule) -> Unit) {
  val colors = SharedTheme.globalColors
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.04f), RoundedCornerShape(6.dp))
        .clickable { onModuleSelected(module) }
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(12.dp),
    horizontalArrangement = Arrangement.SpaceBetween,
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Column {
      Text(module.name, fontSize = 13.sp)
      Text(
        module.path,
        fontSize = 11.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
      )
    }
    Text(
      "→",
      fontSize = 14.sp,
      color = colors.text.normal.copy(alpha = 0.3f),
    )
  }
}

@Composable
private fun RelatedTestRow(
  name: String,
  sharedScreens: List<String>,
  flakiness: Float,
  isCompact: Boolean,
) {
  val colors = SharedTheme.globalColors
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(4.dp))
        .padding(8.dp),
    horizontalArrangement = Arrangement.SpaceBetween,
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Column(modifier = Modifier.weight(1f)) {
      Text(name, fontSize = 11.sp)
      if (!isCompact) {
        Text(
          "Shares: ${sharedScreens.joinToString(", ")}",
          fontSize = 9.sp,
          color = colors.text.normal.copy(alpha = 0.4f),
        )
      }
    }
    if (flakiness > 0.05f) {
      Text(
        if (isCompact) "${(flakiness * 100).toInt()}%" else "${(flakiness * 100).toInt()}% flaky",
        fontSize = 9.sp,
        color = if (flakiness > 0.1f) Color(0xFFFF9800) else colors.text.normal.copy(alpha = 0.5f),
      )
    } else {
      Text(
        if (isCompact) "✓" else "Stable",
        fontSize = 9.sp,
        color = Color(0xFF4CAF50).copy(alpha = 0.8f),
      )
    }
  }
}

@Composable
private fun PlanYamlViewer(
  content: String,
  scrollState: androidx.compose.foundation.ScrollState,
  modifier: Modifier,
) {
  val colors = SharedTheme.globalColors
  // YAML code viewer with syntax highlighting
  Box(
    modifier =
      modifier
        .fillMaxWidth()
        .background(Color(0xFF1E1E1E), RoundedCornerShape(8.dp))
        .border(1.dp, colors.text.normal.copy(alpha = 0.1f), RoundedCornerShape(8.dp))
        .padding(12.dp),
  ) {
    Column(modifier = Modifier.fillMaxSize().verticalScroll(scrollState)) {
      val highlightedYaml = highlightYaml(content)
      Text(
        text = highlightedYaml,
        fontSize = 12.sp,
        fontFamily = FontFamily.Monospace,
      )
    }
  }
}

@Composable
private fun StepScreenshotThumbnail(step: TestStep, isCompact: Boolean) {
  // Screenshot thumbnail - smaller in compact mode
  if (!isCompact) {
    Box(
      modifier =
        Modifier.width(48.dp).height(85.dp).background(Color(0xFF2A2A2A), RoundedCornerShape(4.dp)),
      contentAlignment = Alignment.Center,
    ) {
      if (step.screenshotPath != null) {
        Column(
          horizontalAlignment = Alignment.CenterHorizontally,
          verticalArrangement = Arrangement.Center,
        ) {
          Text(
            step.screenName?.take(6) ?: "?",
            fontSize = 8.sp,
            color = Color.White.copy(alpha = 0.7f),
          )
        }
      } else {
        Text(
          "—",
          fontSize = 10.sp,
          color = Color.White.copy(alpha = 0.3f),
        )
      }
    }
    Spacer(Modifier.width(12.dp))
  }
}

@Composable
private fun StepDetails(
  step: TestStep,
  isCurrentStep: Boolean,
  isCompact: Boolean,
  statusColor: Color,
  modifier: Modifier,
) {
  val colors = SharedTheme.globalColors
  Column(modifier = modifier) {
    StepActionHeading(step, isCompact, statusColor)

    if (!isCompact) {
      step.screenName?.let {
        Text(
          "on $it",
          fontSize = 10.sp,
          color = colors.text.normal.copy(alpha = 0.5f),
          modifier = Modifier.padding(top = 2.dp),
        )
      }
    }

    step.errorMessage?.let { error ->
      Spacer(Modifier.height(4.dp))
      // Show full error when selected, ellipses otherwise
      val displayError =
        if (isCurrentStep) {
          error // Full stacktrace/error when selected
        } else if (error.length > 35) {
          error.take(35) + "..."
        } else {
          error
        }
      Text(
        displayError,
        fontSize = 10.sp,
        color = Color(0xFFFF5722),
      )
    }
  }
}

@Composable
private fun StepActionHeading(step: TestStep, isCompact: Boolean, statusColor: Color) {
  val colors = SharedTheme.globalColors
  Row(
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    // Step number
    Text(
      "${step.index + 1}",
      fontSize = if (isCompact) 10.sp else 11.sp,
      color = colors.text.normal.copy(alpha = 0.4f),
    )

    // Status indicator
    Box(
      modifier = Modifier.size(if (isCompact) 6.dp else 8.dp).background(statusColor, CircleShape),
    )

    // Action - truncate in compact mode
    val actionText =
      if (isCompact && step.target.length > 15) {
        "${step.action}: ${step.target.take(15)}..."
      } else {
        "${step.action}: ${step.target}"
      }
    Text(
      actionText,
      fontSize = if (isCompact) 11.sp else 12.sp,
    )
  }
}

private class TestDashboardState {
  var currentScreen by mutableStateOf(TestScreen.Dashboard)
  var selectedTestRun by mutableStateOf<TestRun?>(null)
  var recordedActions by mutableStateOf<List<RecordedAction>>(emptyList())
  var testRuns by mutableStateOf<List<TestRun>>(emptyList())
  var isLoading by mutableStateOf(true)
  var error by mutableStateOf<String?>(null)
  var currentHierarchyUpdate by mutableStateOf<HierarchyStreamUpdate?>(null)
  var currentScreenshotUpdate by mutableStateOf<ScreenshotStreamUpdate?>(null)
  var currentNavigationUpdate by mutableStateOf<NavigationGraphStreamUpdate?>(null)
}

@Composable
private fun ClearTestNavigation(options: TestDashboardOptions, state: TestDashboardState) {

  with(state) {
    // Clear navigation data when foreground app changes to avoid stale data mismatch
    val currentForegroundPackage = currentHierarchyUpdate?.packageName
    LaunchedEffect(currentForegroundPackage) {
      if (
        currentForegroundPackage != null &&
          currentNavigationUpdate?.appId != currentForegroundPackage
      ) {
        LOG.info(
          "Foreground app changed to $currentForegroundPackage, clearing stale navigation data",
        )
        currentNavigationUpdate = null
      }
    }
  }
}

@Composable
private fun CollectTestHierarchy(options: TestDashboardOptions, state: TestDashboardState) {

  val observationStreamClient = options.observationStreamClient

  with(state) {
    // Collect real-time hierarchy updates from the stream
    LaunchedEffect(observationStreamClient) {
      if (observationStreamClient == null) return@LaunchedEffect

      LOG.info("Starting hierarchy updates collection in TestDashboard")
      observationStreamClient.hierarchyUpdates.collect { update ->
        LOG.info(
          "Received hierarchy update in TestDashboard - deviceId=${update.deviceId}, hasData=${update.data != null}",
        )
        currentHierarchyUpdate = update
      }
    }
  }
}

@Composable
private fun CollectTestScreenshots(options: TestDashboardOptions, state: TestDashboardState) {

  val observationStreamClient = options.observationStreamClient

  with(state) {
    // Collect real-time screenshot updates from the stream
    LaunchedEffect(observationStreamClient) {
      if (observationStreamClient == null) return@LaunchedEffect

      LOG.info("Starting screenshot updates collection in TestDashboard")
      observationStreamClient.screenshotUpdates.collect { update ->
        LOG.info(
          "Received screenshot update in TestDashboard - deviceId=${update.deviceId}, hasScreenshot=${update.screenshotBase64 != null}",
        )
        currentScreenshotUpdate = update
      }
    }
  }
}

@Composable
private fun CollectTestNavigation(options: TestDashboardOptions, state: TestDashboardState) {

  val observationStreamClient = options.observationStreamClient

  with(state) {
    // Collect real-time navigation updates from the stream
    // Filter by current foreground app to ensure navigation data matches the displayed
    // screenshot/hierarchy
    LaunchedEffect(observationStreamClient) {
      if (observationStreamClient == null) return@LaunchedEffect

      LOG.info("Starting navigation updates collection in TestDashboard")
      observationStreamClient.navigationUpdates.collect { update ->
        // Get current foreground package name from hierarchy
        val foregroundPackage = currentHierarchyUpdate?.packageName
        // Only accept navigation updates that match the foreground app (or if no hierarchy yet)
        if (foregroundPackage == null || update.appId == foregroundPackage) {
          LOG.info(
            "Received navigation update in TestDashboard - appId=${update.appId}, nodes=${update.nodes.size}",
          )
          currentNavigationUpdate = update
        } else {
          LOG.info(
            "Ignoring navigation update for ${update.appId} (foreground is $foregroundPackage)",
          )
        }
      }
    }
  }
}

@Composable
private fun LoadTestDashboardRuns(options: TestDashboardOptions, state: TestDashboardState) {

  val dataSourceMode = options.dataSourceMode
  val clientProvider = options.clientProvider

  with(state) {
    val graph = LocalAutoMobileGraph.current
    LaunchedEffect(dataSourceMode, clientProvider) {
      isLoading = true
      error = null
      kotlinx.coroutines.withContext(options.ioDispatcher) {
        try {
          val dataSource =
            graph.dataSourceFactory.createTestDataSource(dataSourceMode, clientProvider)
          when (val result = dataSource.getTestRuns()) {
            is dev.jasonpearson.automobile.desktop.core.datasource.Result.Success -> {
              testRuns = result.data
              isLoading = false
            }
            is dev.jasonpearson.automobile.desktop.core.datasource.Result.Error -> {
              error = result.message
              isLoading = false
            }
            is dev.jasonpearson.automobile.desktop.core.datasource.Result.Loading -> {
              // Keep loading state
            }
          }
        } catch (e: dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException) {
          LOG.warn("Test dashboard operation failed", e)

          error = e.message ?: "Unknown error"
          isLoading = false
        } catch (e: IllegalArgumentException) {
          LOG.warn("Test dashboard operation failed", e)

          error = e.message ?: "Unknown error"
          isLoading = false
        }
      }
    }
  }
}

@Composable
private fun TestDashboardScreen(options: TestDashboardOptions, state: TestDashboardState) {

  val deviceGestureRecordingClient = options.deviceGestureRecordingClient
  val fileSaver = options.fileSaver

  with(state) {
    when (currentScreen) {
      TestScreen.Dashboard ->
        TestDashboardHome(
          testRuns = testRuns,
          isLoading = isLoading,
          error = error,
          onRecordTest = { currentScreen = TestScreen.RecordingTest },
          onTestRunClick = { run ->
            selectedTestRun = run
            currentScreen = TestScreen.TestRunDetail
          },
        )
      TestScreen.RecordingTest ->
        RecordingTestScreen(
          options =
            RecordingTestOptions(
              recordedActions = recordedActions,
              onActionRecorded = { recordedActions = recordedActions + it },
              onFinishRecording = {
                recordedActions = emptyList()
                currentScreen = TestScreen.Dashboard
              },
              onBack = {
                recordedActions = emptyList()
                currentScreen = TestScreen.Dashboard
              },
              screenshotUpdate = currentScreenshotUpdate,
              hierarchyUpdate = currentHierarchyUpdate,
              navigationUpdate = currentNavigationUpdate,
              deviceGestureRecordingClient = deviceGestureRecordingClient,
              fileSaver = fileSaver,
            ),
        )
      TestScreen.ModuleSelection ->
        ModuleSelectionScreen(
          recordedActions = recordedActions,
          onModuleSelected = { module ->
            // TODO: Export YAML and open file
            recordedActions = emptyList()
            currentScreen = TestScreen.Dashboard
          },
          onBack = { currentScreen = TestScreen.RecordingTest },
        )
      TestScreen.TestRunDetail -> SelectedTestRunScreen(options, state)
    }
  }
}

@Composable
private fun SelectedTestRunScreen(options: TestDashboardOptions, state: TestDashboardState) {

  val onNavigateToGraph = options.onNavigateToGraph

  with(state) {
    selectedTestRun?.let { run ->
      TestRunDetailScreen(
        testRun = run,
        allTestRuns = testRuns,
        onBack = { currentScreen = TestScreen.Dashboard },
        onViewInGraph = { onNavigateToGraph(run.screensVisited) },
        onNavigateToRun = { runId ->
          // Navigate to another test run by ID
          val targetRun =
            testRuns.find { it.id == runId } ?: TestMockData.recentRuns.find { it.id == runId }
          if (targetRun != null) {
            selectedTestRun = targetRun
          }
        },
      )
    } ?: run { currentScreen = TestScreen.Dashboard }
  }
}

private fun cacheFrameFailure(cacheKey: String, error: Exception): org.jetbrains.skia.Image? {
  LOG.warn("Test dashboard operation failed", error)
  LoggerFactory.getLogger("VideoPlayer").debug("Failed to extract video frame: ${error.message}")
  frameCache[cacheKey] = null
  return null
}

private fun sortDashboardRuns(selectedFilter: TestFilter, testRuns: List<TestRun>): List<TestRun> =
  when (selectedFilter) {
    TestFilter.Recent -> testRuns.sortedByDescending { it.startTime }
    TestFilter.Popular ->
      testRuns.sortedByDescending { run ->
        // Use sampleSize if available, otherwise look up from mock data
        if (run.sampleSize > 0) run.sampleSize
        else TestMockData.testCases.find { it.id == run.testId }?.runCount ?: 0
      }
    TestFilter.Both ->
      testRuns.sortedByDescending { run ->
        val popularity =
          if (run.sampleSize > 0) run.sampleSize
          else TestMockData.testCases.find { it.id == run.testId }?.runCount ?: 0
        run.startTime + popularity * 100_000
      }
  }

@Composable
private fun TestRunFilterHeader(
  selectedFilter: TestFilter,
  onFilterSelected: (TestFilter) -> Unit,
) {
  val colors = SharedTheme.globalColors
  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.SpaceBetween,
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text("Test Runs", fontSize = 14.sp, color = colors.text.normal.copy(alpha = 0.8f))

    // Filter chips
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
      FilterChip(
        label = "Recent",
        selected = selectedFilter == TestFilter.Recent,
        onClick = { onFilterSelected(TestFilter.Recent) },
      )
      FilterChip(
        label = "Popular",
        selected = selectedFilter == TestFilter.Popular,
        onClick = { onFilterSelected(TestFilter.Popular) },
      )
      FilterChip(
        label = "Both",
        selected = selectedFilter == TestFilter.Both,
        onClick = { onFilterSelected(TestFilter.Both) },
      )
    }
  }
}

@Composable
private fun LoadingTestRuns() {
  val colors = SharedTheme.globalColors
  Box(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.04f), RoundedCornerShape(6.dp))
        .padding(16.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      "Loading test data...",
      fontSize = 12.sp,
      color = colors.text.normal.copy(alpha = 0.6f),
    )
  }
}

@Composable
private fun TestRunsError(error: String) {

  Box(
    modifier =
      Modifier.fillMaxWidth()
        .background(Color(0xFFFF5722).copy(alpha = 0.1f), RoundedCornerShape(6.dp))
        .padding(16.dp),
  ) {
    Text(error, fontSize = 12.sp, color = Color(0xFFFF5722))
  }
}

@Composable
private fun EmptyTestRuns() {
  val colors = SharedTheme.globalColors
  Box(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.04f), RoundedCornerShape(6.dp))
        .padding(16.dp),
    contentAlignment = Alignment.Center,
  ) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
      Text("No test runs yet", fontSize = 13.sp, color = colors.text.normal.copy(alpha = 0.6f))
      Text(
        "Record or run exploratory tests to see them here",
        fontSize = 11.sp,
        color = colors.text.normal.copy(alpha = 0.4f),
        modifier = Modifier.padding(top = 4.dp),
      )
    }
  }
}

@Composable
private fun TestRunList(
  sortedRuns: List<TestRun>,
  isLoading: Boolean,
  error: String?,
  onTestRunClick: (TestRun) -> Unit,
) {
  // Loading state
  if (isLoading) {
    LoadingTestRuns()
  }
  // Error state
  else if (error != null) {
    TestRunsError(error)
  }
  // Empty state
  else if (sortedRuns.isEmpty()) {
    EmptyTestRuns()
  }
  // Data state
  else {
    sortedRuns.forEach { run ->
      // Use sampleSize from run if available, otherwise fall back to mock data
      val testCase = TestMockData.testCases.find { it.id == run.testId }
      val runCount = if (run.sampleSize > 0) run.sampleSize else testCase?.runCount ?: 0
      TestRunRowEnhanced(
        run = run,
        runCount = runCount,
        flakinessScore = testCase?.flakinessScore ?: 0f,
        onClick = { onTestRunClick(run) },
      )
      Spacer(Modifier.height(6.dp))
    }
  }
}

@Composable
private fun PlanReviewButtons(
  saveSuccess: String?,
  copySuccess: Boolean,
  onSave: () -> Unit,
  onCopy: () -> Unit,
  onDismiss: () -> Unit,
) {
  // Action buttons
  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    OutlinedButton(
      onClick = onSave,
      modifier = Modifier.weight(1f),
    ) {
      Text(saveSuccess?.let { "Saved!" } ?: "Save")
    }

    OutlinedButton(
      onClick = onCopy,
      modifier = Modifier.weight(1f),
    ) {
      Text(if (copySuccess) "Copied!" else "Copy")
    }

    Button(
      onClick = onDismiss,
      modifier = Modifier.weight(1f),
    ) {
      Text("Dismiss")
    }
  }
}

private class RecordingSessionState {
  var recordingPhase by mutableStateOf(RecordingPhase.Setup)
  var promptText by mutableStateOf("")
  var isLoadingAnalysis by mutableStateOf(true)
  var promptExpanded by mutableStateOf(false)
  var currentRecordingId by mutableStateOf<String?>(null)
  var exportedPlan by mutableStateOf<ExportedPlan?>(null)
  var isStoppingRecording by mutableStateOf(false)
  var stopError by mutableStateOf<String?>(null)
  var dotCount by mutableStateOf(0)
}

private data class RecordingContext(
  val options: RecordingTestOptions,
  val state: RecordingSessionState,
  val coroutineScope: kotlinx.coroutines.CoroutineScope,
  val screenshotBytes: ByteArray?,
)

@Composable
private fun RecordingSetup(context: RecordingContext) {
  val options = context.options

  with(options) {
    with(context.state) {
      val colors = SharedTheme.globalColors

      // ============ SETUP PHASE ============
      val scrollState = rememberScrollState()
      Column(modifier = Modifier.fillMaxSize().verticalScroll(scrollState).padding(16.dp)) {
        Link("← Back", onClick = onBack)
        Spacer(Modifier.height(12.dp))

        Text("Record Test", fontSize = 18.sp)
        Text(
          "Create and record a UI test",
          color = colors.text.normal.copy(alpha = 0.6f),
          fontSize = 12.sp,
          modifier = Modifier.padding(top = 4.dp),
        )

        Spacer(Modifier.height(24.dp))

        // Prompt input
        Text("Prompt", fontSize = 13.sp, color = colors.text.normal.copy(alpha = 0.8f))
        Spacer(Modifier.height(8.dp))

        RecordingPromptInput(context)
        RecordingSuggestions(context)
        RecordingCoverage(context.state)
      }
    }
  }
}

@Composable
private fun RecordingActive(context: RecordingContext) {
  val options = context.options

  with(options) {
    with(context.state) {
      val colors = SharedTheme.globalColors

      // ============ RECORDING PHASE ============
      Column(modifier = Modifier.fillMaxSize()) {
        RecordingHeader(context)

        RecordingExpandedPrompt(context)
        // Instructions
        Box(
          modifier =
            Modifier.fillMaxWidth()
              .padding(horizontal = 16.dp)
              .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(8.dp))
              .padding(12.dp),
        ) {
          Text(
            "Use your AI agent (Claude Code, Codex, etc.) to interact with the app. " +
              "Tool calls will be recorded below.",
            fontSize = 12.sp,
            color = colors.text.normal.copy(alpha = 0.7f),
          )
        }

        Spacer(Modifier.height(12.dp))

        RecordingLiveContent(context)

        Spacer(Modifier.height(12.dp))

        // Launch buttons
        Row(
          modifier =
            Modifier.fillMaxWidth()
              .background(colors.text.normal.copy(alpha = 0.03f))
              .padding(12.dp),
          horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
          OutlinedButton(onClick = { /* TODO: Launch Claude Code */ }) {
            Text("Launch Claude Code")
          }
          OutlinedButton(onClick = { /* TODO: Launch Codex */ }) { Text("Launch Codex") }
        }

        // Error display if stop failed
        stopError?.let { error ->
          Spacer(Modifier.height(8.dp))
          Box(
            modifier =
              Modifier.fillMaxWidth()
                .padding(horizontal = 16.dp)
                .background(Color(0xFFFF5722).copy(alpha = 0.1f), RoundedCornerShape(6.dp))
                .padding(12.dp),
          ) {
            Text(error, fontSize = 12.sp, color = Color(0xFFFF5722))
          }
        }
      }
    }
  }
}

@Composable
private fun RecordingReview(context: RecordingContext) {
  val options = context.options

  with(options) {
    with(context.state) {

      // ============ REVIEWING PHASE ============
      exportedPlan?.let { plan ->
        PlanReviewPanel(
          plan = plan,
          onSave = { /* handled in PlanReviewPanel */ },
          onCopy = { /* handled in PlanReviewPanel */ },
          onDismiss = {
            exportedPlan = null
            onFinishRecording()
          },
          fileSaver = fileSaver,
        )
      }
        ?: run {
          // Fallback if no plan (shouldn't happen)
          onFinishRecording()
        }
    }
  }
}

@Composable
private fun rememberRecordingScreenshot(screenshotUpdate: ScreenshotStreamUpdate?): ByteArray? {
  val screenshotBytes =
    remember(screenshotUpdate?.screenshotBase64) {
      screenshotUpdate?.screenshotBase64?.let { base64 ->
        try {
          java.util.Base64.getDecoder().decode(base64)
        } catch (e: IllegalArgumentException) {
          LOG.warn("Failed to decode recording screenshot", e)
          null
        }
      }
    }

  return screenshotBytes
}

@Composable
private fun RecordingPromptInput(context: RecordingContext) {
  val options = context.options

  with(options) {
    with(context.state) {
      val colors = SharedTheme.globalColors

      val placeholderText = "Describe what you want to test..."
      val isEmpty = promptText.isEmpty()
      // Prompt input row with multiline text area, Clear, and Start buttons
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Bottom,
      ) {
        Box(
          modifier =
            Modifier.weight(1f)
              .height(80.dp)
              .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(6.dp))
              .padding(8.dp),
        ) {
          // Placeholder text when empty
          if (isEmpty) {
            Text(
              placeholderText,
              fontSize = 12.sp,
              color = colors.text.normal.copy(alpha = 0.4f),
            )
          }
          androidx.compose.foundation.text.BasicTextField(
            value = promptText,
            onValueChange = { promptText = it },
            modifier = Modifier.fillMaxSize(),
            textStyle =
              androidx.compose.ui.text.TextStyle(
                fontSize = 12.sp,
                color = colors.text.normal,
              ),
            minLines = 2,
            maxLines = 4,
          )
        }

        // Clear button - only enabled when there's text
        if (!isEmpty) {
          OutlinedButton(onClick = { promptText = "" }) {
            Text("Clear")
          }
        }

        Button(onClick = { recordingPhase = RecordingPhase.Recording }) {
          Text("Start")
        }
      }

      Spacer(Modifier.height(16.dp))
    }
  }
}

@Composable
private fun RecordingSuggestions(context: RecordingContext) {
  val options = context.options

  with(options) {
    with(context.state) {
      val colors = SharedTheme.globalColors

      // Suggested prompts - only show after analysis loads
      if (!isLoadingAnalysis) {
        Text("Suggested", fontSize = 12.sp, color = colors.text.normal.copy(alpha = 0.5f))
        Spacer(Modifier.height(6.dp))

        // Heuristically generated prompts based on coverage analysis
        val suggestedPrompts =
          listOf(
            "Test the VideoCall screen - try starting, ending, and muting calls",
            "Explore Privacy settings and verify all toggles work correctly",
            "Test the VoiceCall → MediaGallery transition with different media types",
          )

        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
          suggestedPrompts.forEach { suggestion ->
            SuggestedPromptChip(
              text = suggestion,
              onClick = { promptText = suggestion },
            )
          }
        }
      }

      Spacer(Modifier.height(20.dp))
    }
  }
}

@Composable
private fun RecordingCoverage(state: RecordingSessionState) {
  val colors = SharedTheme.globalColors
  with(state) {
    // Coverage analysis with loading state
    Box(
      modifier =
        Modifier.fillMaxWidth()
          .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(8.dp))
          .padding(16.dp),
    ) {
      if (isLoadingAnalysis) {
        Row(
          horizontalArrangement = Arrangement.spacedBy(12.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          // Simple animated loading dots using LaunchedEffect
          var dotCount by remember { mutableStateOf(0) }
          LaunchedEffect(Unit) {
            while (true) {
              kotlinx.coroutines.delay(300)
              dotCount = (dotCount + 1) % 4
            }
          }
          val dots = ".".repeat(dotCount)
          Text(
            "Analyzing coverage$dots",
            fontSize = 12.sp,
            color = colors.text.normal.copy(alpha = 0.6f),
          )
        }
      } else {
        Column {
          Text("Coverage Analysis", fontSize = 13.sp)
          Spacer(Modifier.height(8.dp))
          Text(
            "Based on your navigation graph, these areas have low test coverage:",
            fontSize = 12.sp,
            color = colors.text.normal.copy(alpha = 0.7f),
          )
          Spacer(Modifier.height(8.dp))
          listOf(
              "VideoCall screen (55% coverage)",
              "Privacy settings flow (58% coverage)",
              "VoiceCall → MediaGallery transition (untested)",
              "GroupChat error handling (no tests)",
            )
            .forEach { item ->
              Text(
                "• $item",
                fontSize = 11.sp,
                color = colors.text.normal.copy(alpha = 0.6f),
                modifier = Modifier.padding(vertical = 2.dp),
              )
            }
        }
      }
    }
  }
}

private fun stopRecording(context: RecordingContext) {
  val options = context.options
  val coroutineScope = context.coroutineScope
  with(options) {
    with(context.state) {
      if (deviceGestureRecordingClient != null && !isStoppingRecording) {
        isStoppingRecording = true
        stopError = null
        coroutineScope.launch(options.ioDispatcher) {
          try {
            val result =
              deviceGestureRecordingClient.stopDeviceGestureRecording(
                recordingId = currentRecordingId,
                planName = null,
              )
            withContext(options.mainDispatcher) {
              exportedPlan =
                ExportedPlan(
                  recordingId = result.recordingId,
                  planName = result.planName,
                  planContent = result.planContent,
                  stepCount = result.stepCount,
                  durationMs = result.durationMs,
                )
              isStoppingRecording = false
              recordingPhase = RecordingPhase.Reviewing
            }
          } catch (e: dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException) {
            recordStopFailure(context, e)
          } catch (e: java.io.IOException) {
            recordStopFailure(context, e)
          } catch (e: IllegalArgumentException) {
            recordStopFailure(context, e)
          } catch (cancellation: kotlinx.coroutines.CancellationException) {
            throw cancellation
          } catch (e: IllegalStateException) {
            recordStopFailure(context, e)
          }
        }
      } else {
        // No client available, just go back to dashboard
        onFinishRecording()
      }
    }
  }
}

private suspend fun recordStopFailure(context: RecordingContext, error: Exception) {
  LOG.warn("Test dashboard operation failed", error)
  withContext(context.options.mainDispatcher) {
    context.state.stopError = error.message ?: "Failed to stop recording"
    context.state.isStoppingRecording = false
  }
}

@Composable
private fun RecordingHeader(context: RecordingContext) {
  val options = context.options

  with(options) {
    with(context.state) {
      val colors = SharedTheme.globalColors

      // Header with recording indicator
      Row(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Link("← Cancel", onClick = onBack)

        // Collapsible prompt indicator
        Row(
          modifier =
            Modifier.clickable { promptExpanded = !promptExpanded }
              .pointerHoverIcon(PointerIcon.Hand)
              .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
              .padding(horizontal = 8.dp, vertical = 4.dp),
          horizontalArrangement = Arrangement.spacedBy(4.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Text(
            if (promptExpanded) "▼" else "▶",
            fontSize = 10.sp,
            color = colors.text.normal.copy(alpha = 0.5f),
          )
          val promptPreview =
            if (promptText.isEmpty()) {
              "No prompt"
            } else if (promptText.length > 20) {
              promptText.take(20) + "..."
            } else {
              promptText
            }
          Text(
            promptPreview,
            fontSize = 11.sp,
            color = colors.text.normal.copy(alpha = 0.6f),
          )
        }

        Row(
          horizontalArrangement = Arrangement.spacedBy(8.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          // Recording indicator (pulsing red dot)
          Box(modifier = Modifier.size(10.dp).background(Color(0xFFFF4444), CircleShape))
          Text("Recording", fontSize = 12.sp, color = Color(0xFFFF4444))
        }

        Button(
          onClick = { stopRecording(context) },
          enabled = !isStoppingRecording,
        ) {
          Text(if (isStoppingRecording) "Stopping..." else "Finish Recording")
        }
      }
    }
  }
}

@Composable
private fun RecordingExpandedPrompt(context: RecordingContext) {
  val options = context.options

  with(options) {
    with(context.state) {
      val colors = SharedTheme.globalColors

      // Expanded prompt section (read-only)
      if (promptExpanded && promptText.isNotEmpty()) {
        Box(
          modifier =
            Modifier.fillMaxWidth()
              .padding(horizontal = 16.dp)
              .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
              .padding(12.dp),
        ) {
          Text(
            promptText,
            fontSize = 12.sp,
            color = colors.text.normal.copy(alpha = 0.7f),
          )
        }
        Spacer(Modifier.height(8.dp))
      }
    }
  }
}

@Composable
private fun androidx.compose.foundation.layout.ColumnScope.RecordingLiveContent(
  context: RecordingContext,
) {
  val options = context.options

  with(options) {
    with(context.state) {

      // Main content - side by side device preview and action log
      Row(
        modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
      ) {
        RecordingDevicePreview(context)
        RecordingActionLog(context)
      }
    }
  }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.RecordingActionLog(
  context: RecordingContext,
) {
  val options = context.options

  with(options) {
    with(context.state) {

      // Right side: Terminal-style action log
      Box(
        modifier =
          Modifier.weight(1f)
            .fillMaxHeight()
            .background(Color(0xFF1E1E1E), RoundedCornerShape(8.dp))
            .padding(12.dp),
      ) {
        if (recordedActions.isEmpty()) {
          EmptyRecordingLog()
        } else {
          Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
            recordedActions.forEachIndexed { index, action ->
              Text(
                "[$index] ${action.toolName}(${action.parameters.entries.joinToString { "${it.key}: ${it.value}" }})",
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
                color = Color(0xFF4EC9B0),
              )
              action.result?.let {
                Text(
                  "    → $it",
                  fontSize = 11.sp,
                  fontFamily = FontFamily.Monospace,
                  color = Color(0xFF888888),
                )
              }
              Spacer(Modifier.height(4.dp))
            }
          }
        }
      }
    }
  }
}

@Composable
private fun RecordingDevicePreview(context: RecordingContext) {
  val options = context.options

  with(options) {
    with(context.state) {
      val colors = SharedTheme.globalColors
      val currentPackageName = hierarchyUpdate?.packageName
      val currentScreenName = navigationUpdate?.currentScreen
      // Left side: Device preview with live screenshot
      Column(modifier = Modifier.width(180.dp).fillMaxHeight()) {
        // Current screen info
        if (currentPackageName != null || currentScreenName != null) {
          Column(
            modifier =
              Modifier.fillMaxWidth()
                .background(
                  colors.text.normal.copy(alpha = 0.05f),
                  RoundedCornerShape(6.dp),
                )
                .padding(8.dp),
          ) {
            currentPackageName?.let { pkg ->
              Text(
                pkg.substringAfterLast('.'),
                fontSize = 11.sp,
                color = colors.text.normal.copy(alpha = 0.8f),
              )
            }
            currentScreenName?.let { screen ->
              Text(
                screen,
                fontSize = 10.sp,
                color = colors.text.normal.copy(alpha = 0.5f),
              )
            }
          }
          Spacer(Modifier.height(8.dp))
        }

        RecordingScreenshot(
          context.screenshotBytes,
          context.options.screenshotUpdate == null,
          Modifier.weight(1f),
        )

        // Navigation info if available
        navigationUpdate?.let { navUpdate ->
          if (navUpdate.nodes.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            Text(
              "${navUpdate.nodes.size} screens discovered",
              fontSize = 10.sp,
              color = Color(0xFF4CAF50),
            )
          }
        }
      }
    }
  }
}

@Composable
private fun RecordingScreenshot(
  screenshotBytes: ByteArray?,
  awaitingFirstUpdate: Boolean,
  modifier: Modifier,
) {
  val colors = SharedTheme.globalColors
  Box(
    modifier =
      modifier
        .fillMaxWidth()
        .background(Color(0xFF1E1E1E), RoundedCornerShape(8.dp))
        .border(1.dp, colors.text.normal.copy(alpha = 0.1f), RoundedCornerShape(8.dp)),
    contentAlignment = Alignment.Center,
  ) {
    if (screenshotBytes != null) RecordingScreenshotImage(screenshotBytes)
    else RecordingScreenshotPlaceholder(awaitingFirstUpdate)
  }
}

@Composable
private fun EmptyRecordingLog() {
  Column {
    Text(
      "$ awaiting tool calls...",
      fontSize = 12.sp,
      fontFamily = FontFamily.Monospace,
      color = Color(0xFF888888),
    )
    Spacer(Modifier.height(16.dp))
    Text(
      "# Example actions that will be recorded:",
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      color = Color(0xFF666666),
    )
    Text(
      "# - tapOn(element: \"Login button\")",
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      color = Color(0xFF666666),
    )
    Text(
      "# - inputText(text: \"user@example.com\")",
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      color = Color(0xFF666666),
    )
    Text(
      "# - swipeOn(direction: \"up\")",
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      color = Color(0xFF666666),
    )
  }
}

@Composable
private fun VideoFrameImage(displayFrame: org.jetbrains.skia.Image?) {
  Box(
    modifier = Modifier.fillMaxWidth().background(Color(0xFF1E1E1E), RoundedCornerShape(8.dp)),
    contentAlignment = Alignment.Center,
  ) {
    if (displayFrame != null) {
      Image(
        bitmap = displayFrame.toComposeImageBitmap(),
        contentDescription = "Video frame",
        modifier = Modifier.fillMaxWidth(),
        contentScale = ContentScale.FillWidth,
      )
    } else {
      // Loading state - show minimal placeholder (only shown initially)
      Box(
        modifier = Modifier.fillMaxWidth().height(200.dp),
        contentAlignment = Alignment.Center,
      ) {
        Text(
          "Loading...",
          fontSize = 12.sp,
          color = Color.White.copy(alpha = 0.5f),
        )
      }
    }
  }
}

@Composable
private fun NoVideoRecording() {
  // No video available
  Box(
    modifier =
      Modifier.fillMaxWidth()
        .height(100.dp)
        .background(Color(0xFF1E1E1E), RoundedCornerShape(8.dp)),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      "No video recording",
      fontSize = 12.sp,
      color = Color.White.copy(alpha = 0.5f),
    )
  }
}

@Composable
private fun VideoPlaybackDisplay(testRun: TestRun, playbackTimeMs: Long) {
  val videoPath = testRun.videoPath
  // Track the current frame and video dimensions
  var videoAspectRatio by remember { mutableStateOf(9f / 16f) } // Default to portrait

  // Keep track of the last successfully loaded frame
  var lastLoadedFrame by remember { mutableStateOf<org.jetbrains.skia.Image?>(null) }

  // Video display area
  if (videoPath != null) {
    // Extract frame at current time, or use last frame time if at end
    val effectiveTimeMs =
      if (playbackTimeMs >= testRun.durationMs) {
        // At end - show frame from slightly before end
        (testRun.durationMs - 100L).coerceAtLeast(0L)
      } else {
        playbackTimeMs
      }

    val frameImage =
      remember(videoPath, effectiveTimeMs) { extractVideoFrame(videoPath, effectiveTimeMs) }

    // Update last loaded frame and aspect ratio when we get a frame
    frameImage?.let { img ->
      lastLoadedFrame = img
      videoAspectRatio = img.width.toFloat() / img.height.toFloat()
    }

    // Use current frame, or fall back to last loaded frame
    val displayFrame = frameImage ?: lastLoadedFrame

    VideoFrameImage(displayFrame)
  } else {
    NoVideoRecording()
  }
}

@Composable
private fun VideoPlaybackProgress(
  testRun: TestRun,
  currentStepIndex: Int,
  playbackTimeMs: Long,
  stepTimestamps: List<Pair<Long, Long>>,
) {
  val colors = SharedTheme.globalColors
  // Progress bar
  val progress = (playbackTimeMs.toFloat() / testRun.durationMs).coerceIn(0f, 1f)
  Box(
    modifier =
      Modifier.fillMaxWidth()
        .height(6.dp)
        .background(colors.text.normal.copy(alpha = 0.1f), RoundedCornerShape(3.dp)),
  ) {
    Box(
      modifier =
        Modifier.fillMaxWidth(progress)
          .height(6.dp)
          .background(Color(0xFF2196F3), RoundedCornerShape(3.dp)),
    )
    // Step markers
    stepTimestamps.forEachIndexed { index, (start, _) ->
      val markerPos = start.toFloat() / testRun.durationMs
      Box(modifier = Modifier.fillMaxWidth(markerPos).height(6.dp)) {
        Box(
          modifier =
            Modifier.align(Alignment.CenterEnd)
              .size(width = 2.dp, height = 6.dp)
              .background(
                if (index == currentStepIndex) Color(0xFF4CAF50)
                else colors.text.normal.copy(alpha = 0.3f),
              ),
        )
      }
    }
  }
}

@Composable
private fun VideoPlaybackLinks(testRun: TestRun, playbackTimeMs: Long) {
  val colors = SharedTheme.globalColors
  val videoPath = testRun.videoPath
  // Time display and Open Video link
  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.SpaceBetween,
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      "${formatTime(playbackTimeMs)} / ${formatTime(testRun.durationMs.toLong())}",
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
    )

    if (videoPath != null) {
      Link(
        text = "Open Video File",
        onClick = {
          try {
            val file = java.io.File(videoPath)
            if (file.exists()) {
              java.awt.Desktop.getDesktop().open(file)
            }
          } catch (e: java.io.IOException) {
            LOG.warn("Test dashboard operation failed", e)

            LoggerFactory.getLogger("VideoPlayer").warn("Failed to open video: ${e.message}")
          } catch (e: UnsupportedOperationException) {
            LOG.warn("Test dashboard operation failed", e)

            LoggerFactory.getLogger("VideoPlayer").warn("Failed to open video: ${e.message}")
          } catch (e: SecurityException) {
            LOG.warn("Test dashboard operation failed", e)

            LoggerFactory.getLogger("VideoPlayer").warn("Failed to open video: ${e.message}")
          }
        },
      )
    }
  }
}

private class DetailPlaybackState {
  var isPlaying by mutableStateOf(false)
  var playbackTimeMs by mutableStateOf(0L)
}

private data class DetailRunActions(
  val onBack: () -> Unit,
  val onViewInGraph: () -> Unit,
  val onNavigateToRun: (String) -> Unit,
)

private data class DetailRunContext(
  val testRun: TestRun,
  val playback: DetailPlaybackState,
  val stepTimestamps: List<Pair<Long, Long>>,
  val currentStepIndex: Int,
  val historicalRuns: List<HistoricalRun>,
  val passRate: Int,
  val actions: DetailRunActions,
)

@Composable
private fun ObserveDetailPlayback(testRun: TestRun, playback: DetailPlaybackState) {
  with(playback) {
    androidx.compose.runtime.LaunchedEffect(isPlaying) {
      if (isPlaying) {
        val startTime = System.currentTimeMillis() - playbackTimeMs
        while (isPlaying && playbackTimeMs < testRun.durationMs) {
          playbackTimeMs = System.currentTimeMillis() - startTime
          kotlinx.coroutines.delay(50) // Update every 50ms
        }
        if (playbackTimeMs >= testRun.durationMs) {
          isPlaying = false
          playbackTimeMs = testRun.durationMs.toLong()
        }
      }
    }
  }
}

@Composable
private fun TestRunDetailContent(
  context: DetailRunContext,
  scrollState: androidx.compose.foundation.ScrollState,
  isWideLayout: Boolean,
) {
  with(context) {
    with(playback) {
      with(actions) {
        Column(modifier = Modifier.fillMaxSize().verticalScroll(scrollState).padding(16.dp)) {
          DetailRunHeader(context, isWideLayout)
          DetailRunIdentity(context, isWideLayout)
          DetailRunHistory(context, isWideLayout)
          DetailRunStepsAndVideo(context, isWideLayout)
          DetailRunScreens(context, isWideLayout)
          DetailRunRelated(context, isWideLayout)
          DetailRunSnapshot(context, isWideLayout)
        }
      }
    }
  }
}

@Composable
private fun DetailRunHeader(context: DetailRunContext, isWideLayout: Boolean) {
  with(context) {
    with(playback) {
      with(actions) {

        // Header row with back, title, playback controls, and view in graph
        Row(
          modifier = Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.SpaceBetween,
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Link("← Back", onClick = onBack)

          // Playback controls in header (if video exists)
          if (testRun.videoPath != null) {
            Row(
              horizontalArrangement = Arrangement.spacedBy(4.dp),
              verticalAlignment = Alignment.CenterVertically,
            ) {
              // Responsive button labels
              val showFullLabels = isWideLayout
              OutlinedButton(
                onClick = {
                  if (playbackTimeMs >= testRun.durationMs) {
                    playbackTimeMs = 0
                  }
                  isPlaying = !isPlaying
                },
              ) {
                Text(
                  if (showFullLabels) {
                    if (isPlaying) "|| Pause" else "> Play"
                  } else {
                    if (isPlaying) "||" else ">"
                  },
                )
              }
              OutlinedButton(
                onClick = {
                  isPlaying = false
                  playbackTimeMs = 0
                },
              ) {
                Text(if (showFullLabels) "[] Reset" else "[]")
              }
            }
          }

          OutlinedButton(onClick = onViewInGraph) {
            Text(if (isWideLayout) "View in Graph" else "📊")
          }
        }

        Spacer(Modifier.height(12.dp))
      }
    }
  }
}

@Composable
private fun DetailRunIdentity(context: DetailRunContext, isWideLayout: Boolean) {
  with(context) {
    with(playback) {
      with(actions) {
        val colors = SharedTheme.globalColors
        // Title with status
        Row(
          horizontalArrangement = Arrangement.spacedBy(10.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          val statusColor =
            when (testRun.status) {
              TestStatus.Passed -> Color(0xFF4CAF50)
              TestStatus.Failed -> Color(0xFFFF5722)
              TestStatus.Running -> Color(0xFF2196F3)
              TestStatus.Skipped -> colors.text.normal.copy(alpha = 0.4f)
            }
          Box(modifier = Modifier.size(12.dp).background(statusColor, CircleShape))
          Text(testRun.testName, fontSize = 18.sp)
        }

        Text(
          "${testRun.deviceName} • ${testRun.durationMs / 1000.0}s",
          color = colors.text.normal.copy(alpha = 0.6f),
          fontSize = 12.sp,
          modifier = Modifier.padding(top = 4.dp),
        )

        // Error message if failed
        val errorMsg = testRun.errorMessage
        if (errorMsg != null) {
          Spacer(Modifier.height(12.dp))
          Box(
            modifier =
              Modifier.fillMaxWidth()
                .background(Color(0xFFFF5722).copy(alpha = 0.1f), RoundedCornerShape(6.dp))
                .padding(12.dp),
          ) {
            Text(
              errorMsg,
              fontSize = 12.sp,
              color = Color(0xFFFF5722),
              fontFamily = FontFamily.Monospace,
            )
          }
        }

        Spacer(Modifier.height(16.dp))
      }
    }
  }
}

@Composable
private fun DetailRunHistory(context: DetailRunContext, isWideLayout: Boolean) {
  with(context) {
    with(playback) {
      with(actions) {

        // Run History - compact chart with pass rate overlay
        RunHistoryChart(
          historicalRuns = historicalRuns,
          passRate = passRate,
          currentRunId = testRun.id,
          onRunClick = { runId -> runId?.let { onNavigateToRun(it) } },
          isCompact = !isWideLayout,
        )

        Spacer(Modifier.height(16.dp))
      }
    }
  }
}

@Composable
private fun DetailRunScreens(context: DetailRunContext, isWideLayout: Boolean) {
  with(context) {
    with(playback) {
      with(actions) {
        val colors = SharedTheme.globalColors
        // Screens visited
        Text("Screens Visited", fontSize = 14.sp, color = colors.text.normal.copy(alpha = 0.8f))
        Spacer(Modifier.height(8.dp))
        Row(
          horizontalArrangement = Arrangement.spacedBy(8.dp),
          modifier = Modifier.fillMaxWidth(),
        ) {
          testRun.screensVisited.forEachIndexed { index, screen ->
            val isCurrentScreen = testRun.steps.getOrNull(currentStepIndex)?.screenName == screen
            Box(
              modifier =
                Modifier.background(
                    if (isCurrentScreen) Color(0xFF2196F3).copy(alpha = 0.2f)
                    else colors.text.normal.copy(alpha = 0.08f),
                    RoundedCornerShape(4.dp),
                  )
                  .then(
                    if (isCurrentScreen)
                      Modifier.border(1.dp, Color(0xFF2196F3), RoundedCornerShape(4.dp))
                    else Modifier,
                  )
                  .padding(horizontal = 8.dp, vertical = 4.dp),
            ) {
              Text(screen, fontSize = 11.sp)
            }
          }
        }

        Spacer(Modifier.height(16.dp))
      }
    }
  }
}

@Composable
private fun DetailRunRelated(context: DetailRunContext, isWideLayout: Boolean) {
  with(context) {
    with(playback) {
      with(actions) {

        // Related Tests
        RelatedTestsSection(
          testRun = testRun,
          isCompact = !isWideLayout,
        )

        Spacer(Modifier.height(16.dp))
      }
    }
  }
}

@Composable
private fun WideDetailRunSteps(context: DetailRunContext, isWideLayout: Boolean) {
  with(context) {
    with(playback) {
      with(actions) {
        val colors = SharedTheme.globalColors

        // Wide layout: steps and video side by side
        Row(
          modifier = Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
          // Steps column
          Column(modifier = Modifier.weight(1f)) {
            Text("Test Steps", fontSize = 14.sp, color = colors.text.normal.copy(alpha = 0.8f))
            Spacer(Modifier.height(8.dp))

            testRun.steps.forEachIndexed { index, step ->
              TestStepRowWithScreenshot(
                step = step,
                isCurrentStep = index == currentStepIndex && (isPlaying || playbackTimeMs > 0),
                onStepClick = {
                  playbackTimeMs = stepTimestamps[index].first
                  isPlaying = false
                },
                isCompact = true,
              )
              Spacer(Modifier.height(6.dp))
            }
          }

          // Video column
          Column(modifier = Modifier.width(180.dp)) {
            Text("Recording", fontSize = 14.sp, color = colors.text.normal.copy(alpha = 0.8f))
            Spacer(Modifier.height(8.dp))

            VideoPlayerWithTimeline(
              testRun = testRun,
              currentStepIndex = currentStepIndex,
              playbackTimeMs = playbackTimeMs,
              stepTimestamps = stepTimestamps,
            )
          }
        }
      }
    }
  }
}

@Composable
private fun NarrowDetailRunSteps(context: DetailRunContext, isWideLayout: Boolean) {
  with(context) {
    with(playback) {
      with(actions) {
        val colors = SharedTheme.globalColors

        // Narrow layout: steps first, then video
        Text("Test Steps", fontSize = 14.sp, color = colors.text.normal.copy(alpha = 0.8f))
        Spacer(Modifier.height(8.dp))

        testRun.steps.forEachIndexed { index, step ->
          TestStepRowWithScreenshot(
            step = step,
            isCurrentStep = index == currentStepIndex && (isPlaying || playbackTimeMs > 0),
            onStepClick = {
              playbackTimeMs = stepTimestamps[index].first
              isPlaying = false
            },
            isCompact = !isWideLayout,
          )
          Spacer(Modifier.height(8.dp))
        }

        // Video after steps (if exists)
        if (testRun.videoPath != null) {
          Spacer(Modifier.height(16.dp))
          Text("Recording", fontSize = 14.sp, color = colors.text.normal.copy(alpha = 0.8f))
          Spacer(Modifier.height(8.dp))

          VideoPlayerWithTimeline(
            testRun = testRun,
            currentStepIndex = currentStepIndex,
            playbackTimeMs = playbackTimeMs,
            stepTimestamps = stepTimestamps,
          )
        }
      }
    }
  }
}

@Composable
private fun DetailRunStepsAndVideo(context: DetailRunContext, isWideLayout: Boolean) {
  with(context) {
    with(playback) {
      with(actions) {

        // Test Steps and Video - side by side if wide, stacked if narrow
        if (isWideLayout && testRun.videoPath != null) {
          WideDetailRunSteps(context, isWideLayout)
        } else {
          NarrowDetailRunSteps(context, isWideLayout)
        }

        Spacer(Modifier.height(16.dp))
      }
    }
  }
}

@Composable
private fun DetailSnapshotActions(
  context: DetailRunContext,
  isWideLayout: Boolean,
  onRestore: () -> Unit,
) {
  with(context) {
    with(playback) {
      with(actions) {
        Row(
          horizontalArrangement = Arrangement.spacedBy(8.dp),
          modifier = Modifier.fillMaxWidth(),
        ) {
          ActionCard(
            options =
              ActionCardOptions(
                icon = "📱",
                title = if (isWideLayout) "Restore to Device" else "Restore",
                description =
                  if (isWideLayout) {
                    "Restore app snapshot to ${if (testRun.platform == TestPlatform.Android) "emulator" else "simulator"}"
                  } else {
                    "Restore snapshot"
                  },
                onClick = onRestore,
                modifier = Modifier.weight(1f),
              ),
          )

          ActionCard(
            options =
              ActionCardOptions(
                icon = "📤",
                title = if (isWideLayout) "Send Snapshot" else "Send",
                description =
                  if (isWideLayout) "Open snapshot file in Finder" else "Open in Finder",
                onClick = { /* TODO: Open Finder with snapshot file selected */ },
                modifier = Modifier.weight(1f),
              ),
          )
        }

        Spacer(Modifier.height(8.dp))
      }
    }
  }
}

@Composable
private fun DetailRunSnapshot(context: DetailRunContext, isWideLayout: Boolean) {
  with(context) {
    with(playback) {
      with(actions) {
        val colors = SharedTheme.globalColors
        // Snapshot & Export section
        val hasSnapshot = testRun.snapshotPath != null
        val sectionTitle = if (hasSnapshot) "Snapshot & Export" else "Export"
        Text(sectionTitle, fontSize = 14.sp, color = colors.text.normal.copy(alpha = 0.8f))
        Spacer(Modifier.height(8.dp))

        var showDevicePicker by remember { mutableStateOf(false) }

        if (hasSnapshot) {
          DetailSnapshotActions(context, isWideLayout) { showDevicePicker = true }
        }

        ActionCard(
          options =
            ActionCardOptions(
              icon = "📦",
              title = if (isWideLayout) "Send Debug Bundle" else "Debug Bundle",
              description =
                if (isWideLayout) {
                  "Export test results, video, screenshots${if (hasSnapshot) " & snapshot" else ""} as portable bundle"
                } else {
                  "Export all test data"
                },
              onClick = { /* TODO: Create and export debug bundle */ },
              modifier = Modifier.fillMaxWidth(),
            ),
        )

        if (showDevicePicker) {
          DevicePickerOverlay(
            platform = testRun.platform,
            onDeviceSelected = { device -> showDevicePicker = false },
            onDismiss = { showDevicePicker = false },
          )
        }
      }
    }
  }
}

@Composable
private fun RecordingScreenshotImage(screenshotBytes: ByteArray) {
  val colors = SharedTheme.globalColors
  // Display the live screenshot
  val imageBitmap =
    remember(screenshotBytes) {
      try {
        val skiaImage = Image.makeFromEncoded(screenshotBytes)
        skiaImage.toComposeImageBitmap()
      } catch (e: IllegalArgumentException) {
        LOG.warn("Test dashboard operation failed", e)

        null
      }
    }
  imageBitmap?.let { bitmap ->
    Image(
      bitmap = bitmap,
      contentDescription = "Live device screen",
      modifier = Modifier.fillMaxSize().padding(4.dp),
      contentScale = ContentScale.Fit,
    )
  }
    ?: run {
      // Fallback if image decode fails
      Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
      ) {
        Text(
          "Device Preview",
          fontSize = 10.sp,
          color = colors.text.normal.copy(alpha = 0.4f),
        )
      }
    }
}

@Composable
private fun RecordingScreenshotPlaceholder(awaitingFirstUpdate: Boolean) {
  val colors = SharedTheme.globalColors
  // No screenshot available yet
  Column(
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center,
  ) {
    Text("📱", fontSize = 24.sp)
    Spacer(Modifier.height(4.dp))
    Text(
      "Awaiting device...",
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.4f),
    )
    if (awaitingFirstUpdate) {
      Spacer(Modifier.height(4.dp))
      Text(
        "Connect a device to see live updates",
        fontSize = 9.sp,
        color = colors.text.normal.copy(alpha = 0.3f),
      )
    }
  }
}
