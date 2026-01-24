package dev.jasonpearson.automobile.ide.test

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.jetbrains.jewel.foundation.theme.JewelTheme
import org.jetbrains.jewel.ui.component.DefaultButton
import org.jetbrains.jewel.ui.component.Link
import org.jetbrains.jewel.ui.component.OutlinedButton
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.component.TextField

enum class TestScreen {
    Dashboard,
    ExploratoryTest,
    RecordingTest,
    ModuleSelection,
    TestRunDetail,
}

@Composable
fun TestDashboard(
    onOpenFile: (String) -> Unit = {},  // Callback to open file in editor
    onNavigateToGraph: (List<String>) -> Unit = {},  // Navigate to nav graph with highlighted screens
) {
    var currentScreen by remember { mutableStateOf(TestScreen.Dashboard) }
    var selectedTestRun by remember { mutableStateOf<TestRun?>(null) }
    var recordedActions by remember { mutableStateOf<List<RecordedAction>>(emptyList()) }

    when (currentScreen) {
        TestScreen.Dashboard -> TestDashboardHome(
            onExploratoryTest = { currentScreen = TestScreen.ExploratoryTest },
            onRecordTest = { currentScreen = TestScreen.RecordingTest },
            onTestClick = { onOpenFile(it.filePath) },
            onTestRunClick = { run ->
                selectedTestRun = run
                currentScreen = TestScreen.TestRunDetail
            },
        )
        TestScreen.ExploratoryTest -> ExploratoryTestScreen(
            onBack = { currentScreen = TestScreen.Dashboard },
        )
        TestScreen.RecordingTest -> RecordingTestScreen(
            recordedActions = recordedActions,
            onActionRecorded = { recordedActions = recordedActions + it },
            onFinishRecording = { currentScreen = TestScreen.ModuleSelection },
            onBack = {
                recordedActions = emptyList()
                currentScreen = TestScreen.Dashboard
            },
        )
        TestScreen.ModuleSelection -> ModuleSelectionScreen(
            recordedActions = recordedActions,
            onModuleSelected = { module ->
                // TODO: Export YAML and open file
                recordedActions = emptyList()
                currentScreen = TestScreen.Dashboard
            },
            onBack = { currentScreen = TestScreen.RecordingTest },
        )
        TestScreen.TestRunDetail -> selectedTestRun?.let { run ->
            TestRunDetailScreen(
                testRun = run,
                onBack = { currentScreen = TestScreen.Dashboard },
                onViewInGraph = { onNavigateToGraph(run.screensVisited) },
            )
        } ?: run { currentScreen = TestScreen.Dashboard }
    }
}

@Composable
private fun TestDashboardHome(
    onExploratoryTest: () -> Unit,
    onRecordTest: () -> Unit,
    onTestClick: (TestCase) -> Unit,
    onTestRunClick: (TestRun) -> Unit,
) {
    val colors = JewelTheme.globalColors
    val scrollState = rememberScrollState()

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(scrollState).padding(16.dp),
    ) {
        Text("Testing", fontSize = 18.sp)
        Text(
            "Create, run, and analyze UI tests",
            color = colors.text.normal.copy(alpha = 0.6f),
            fontSize = 12.sp,
            modifier = Modifier.padding(top = 4.dp),
        )

        Spacer(Modifier.height(20.dp))

        // Action buttons
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            DefaultButton(onClick = onExploratoryTest) {
                Text("🔍 Exploratory Test")
            }
            OutlinedButton(onClick = onRecordTest) {
                Text("⏺ Record Test")
            }
        }

        Spacer(Modifier.height(24.dp))

        // Recent & Popular Tests
        Text("Recent & Popular Tests", fontSize = 14.sp, color = colors.text.normal.copy(alpha = 0.8f))
        Spacer(Modifier.height(8.dp))

        val sortedTests = remember {
            TestMockData.testCases.sortedByDescending {
                (it.lastRunTime ?: 0) + it.runCount * 10_000
            }
        }

        sortedTests.take(5).forEach { test ->
            TestCaseRow(
                test = test,
                onClick = { onTestClick(test) },
            )
            Spacer(Modifier.height(6.dp))
        }

        Spacer(Modifier.height(24.dp))

        // Recent Test Runs
        Text("Recent Test Runs", fontSize = 14.sp, color = colors.text.normal.copy(alpha = 0.8f))
        Spacer(Modifier.height(8.dp))

        TestMockData.recentRuns.forEach { run ->
            TestRunRow(
                run = run,
                onClick = { onTestRunClick(run) },
            )
            Spacer(Modifier.height(6.dp))
        }
    }
}

@Composable
private fun TestCaseRow(test: TestCase, onClick: () -> Unit) {
    val colors = JewelTheme.globalColors
    val statusColor = when (test.lastRunStatus) {
        TestStatus.Passed -> Color(0xFF4CAF50)
        TestStatus.Failed -> Color(0xFFFF5722)
        TestStatus.Running -> Color(0xFF2196F3)
        TestStatus.Skipped -> colors.text.normal.copy(alpha = 0.4f)
        null -> colors.text.normal.copy(alpha = 0.3f)
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
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
            Box(
                modifier = Modifier.size(8.dp).background(statusColor, CircleShape)
            )
            Column {
                Text(test.name, fontSize = 13.sp)
                Text(
                    "${test.className} • ${test.runCount} runs",
                    fontSize = 11.sp,
                    color = colors.text.normal.copy(alpha = 0.5f),
                )
            }
        }

        Column(horizontalAlignment = Alignment.End) {
            Text(
                "${test.avgDurationMs / 1000.0}s",
                fontSize = 11.sp,
                color = colors.text.normal.copy(alpha = 0.5f),
            )
            if (test.flakinessScore > 0.1f) {
                Text(
                    "${(test.flakinessScore * 100).toInt()}% flaky",
                    fontSize = 10.sp,
                    color = Color(0xFFFFC107),
                )
            }
        }
    }
}

@Composable
private fun TestRunRow(run: TestRun, onClick: () -> Unit) {
    val colors = JewelTheme.globalColors
    val statusColor = when (run.status) {
        TestStatus.Passed -> Color(0xFF4CAF50)
        TestStatus.Failed -> Color(0xFFFF5722)
        TestStatus.Running -> Color(0xFF2196F3)
        TestStatus.Skipped -> colors.text.normal.copy(alpha = 0.4f)
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
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
            Box(
                modifier = Modifier.size(8.dp).background(statusColor, CircleShape)
            )
            Column {
                Text(run.testName, fontSize = 13.sp)
                Text(
                    "${run.deviceName} • ${run.steps.size} steps",
                    fontSize = 11.sp,
                    color = colors.text.normal.copy(alpha = 0.5f),
                )
            }
        }

        Column(horizontalAlignment = Alignment.End) {
            Text(
                "${run.durationMs / 1000.0}s",
                fontSize = 11.sp,
                color = colors.text.normal.copy(alpha = 0.5f),
            )
            if (run.status == TestStatus.Failed) {
                Text(
                    "Failed",
                    fontSize = 10.sp,
                    color = Color(0xFFFF5722),
                )
            }
        }
    }
}

@Composable
private fun ExploratoryTestScreen(onBack: () -> Unit) {
    val colors = JewelTheme.globalColors

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
    ) {
        Link("← Back", onClick = onBack)
        Spacer(Modifier.height(12.dp))

        Text("Exploratory Test", fontSize = 18.sp)
        Text(
            "Let AI explore untested areas of your app",
            color = colors.text.normal.copy(alpha = 0.6f),
            fontSize = 12.sp,
            modifier = Modifier.padding(top = 4.dp),
        )

        Spacer(Modifier.height(24.dp))

        // Coverage hint
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(8.dp))
                .padding(16.dp),
        ) {
            Column {
                Text("📊 Coverage Analysis", fontSize = 13.sp)
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
                ).forEach { item ->
                    Text(
                        "• $item",
                        fontSize = 11.sp,
                        color = colors.text.normal.copy(alpha = 0.6f),
                        modifier = Modifier.padding(vertical = 2.dp),
                    )
                }
            }
        }

        Spacer(Modifier.height(20.dp))

        // Prompt input
        Text("Exploration Prompt", fontSize = 13.sp, color = colors.text.normal.copy(alpha = 0.8f))
        Spacer(Modifier.height(8.dp))

        val promptState = remember {
            TextFieldState("Explore the app focusing on areas with low test coverage. " +
                "Try the VideoCall and VoiceCall features, and test edge cases in the Privacy settings.")
        }

        TextField(
            state = promptState,
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(16.dp))

        DefaultButton(onClick = { /* TODO: Start exploration */ }) {
            Text("🚀 Start Exploration")
        }
    }
}

@Composable
private fun RecordingTestScreen(
    recordedActions: List<RecordedAction>,
    onActionRecorded: (RecordedAction) -> Unit,
    onFinishRecording: () -> Unit,
    onBack: () -> Unit,
) {
    val colors = JewelTheme.globalColors

    Column(modifier = Modifier.fillMaxSize()) {
        // Header with recording indicator
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Link("← Cancel", onClick = onBack)
            }

            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Recording indicator (pulsing red dot)
                Box(
                    modifier = Modifier
                        .size(10.dp)
                        .background(Color(0xFFFF4444), CircleShape)
                )
                Text("Recording", fontSize = 12.sp, color = Color(0xFFFF4444))
            }

            DefaultButton(onClick = onFinishRecording) {
                Text("✓ Finish Recording")
            }
        }

        // Instructions
        Box(
            modifier = Modifier
                .fillMaxWidth()
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

        // Terminal-style action log
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .background(Color(0xFF1E1E1E))
                .padding(12.dp),
        ) {
            if (recordedActions.isEmpty()) {
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
            } else {
                Column(
                    modifier = Modifier.verticalScroll(rememberScrollState()),
                ) {
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

        // Launch buttons
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.text.normal.copy(alpha = 0.03f))
                .padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedButton(onClick = { /* TODO: Launch Claude Code */ }) {
                Text("Launch Claude Code")
            }
            OutlinedButton(onClick = { /* TODO: Launch Codex */ }) {
                Text("Launch Codex")
            }
        }
    }
}

@Composable
private fun ModuleSelectionScreen(
    recordedActions: List<RecordedAction>,
    onModuleSelected: (GradleModule) -> Unit,
    onBack: () -> Unit,
) {
    val colors = JewelTheme.globalColors
    val searchState = remember { TextFieldState("") }

    val filteredModules = remember(searchState.text.toString()) {
        val query = searchState.text.toString()
        if (query.isBlank()) {
            TestMockData.modules
        } else {
            TestMockData.modules.filter {
                it.name.contains(query, ignoreCase = true) ||
                    it.path.contains(query, ignoreCase = true)
            }
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
    ) {
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
            state = searchState,
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(12.dp))

        // Module list
        Column(
            modifier = Modifier.verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            filteredModules.forEach { module ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
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
        }
    }
}

@Composable
private fun TestRunDetailScreen(
    testRun: TestRun,
    onBack: () -> Unit,
    onViewInGraph: () -> Unit,
) {
    val colors = JewelTheme.globalColors
    val scrollState = rememberScrollState()

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(scrollState).padding(16.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Link("← Back", onClick = onBack)
            OutlinedButton(onClick = onViewInGraph) {
                Text("🌐 View in Graph")
            }
        }

        Spacer(Modifier.height(12.dp))

        // Header
        Row(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val statusColor = when (testRun.status) {
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

        if (testRun.errorMessage != null) {
            Spacer(Modifier.height(12.dp))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFFFF5722).copy(alpha = 0.1f), RoundedCornerShape(6.dp))
                    .padding(12.dp),
            ) {
                Text(
                    testRun.errorMessage,
                    fontSize = 12.sp,
                    color = Color(0xFFFF5722),
                    fontFamily = FontFamily.Monospace,
                )
            }
        }

        Spacer(Modifier.height(20.dp))

        // Screens visited
        Text("Screens Visited", fontSize = 14.sp, color = colors.text.normal.copy(alpha = 0.8f))
        Spacer(Modifier.height(8.dp))
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            testRun.screensVisited.forEach { screen ->
                Box(
                    modifier = Modifier
                        .background(colors.text.normal.copy(alpha = 0.08f), RoundedCornerShape(4.dp))
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                ) {
                    Text(screen, fontSize = 11.sp)
                }
            }
        }

        Spacer(Modifier.height(20.dp))

        // Steps
        Text("Test Steps", fontSize = 14.sp, color = colors.text.normal.copy(alpha = 0.8f))
        Spacer(Modifier.height(8.dp))

        testRun.steps.forEach { step ->
            TestStepRow(step)
            Spacer(Modifier.height(6.dp))
        }

        Spacer(Modifier.height(20.dp))

        // Artifacts section
        Text("Artifacts", fontSize = 14.sp, color = colors.text.normal.copy(alpha = 0.8f))
        Spacer(Modifier.height(8.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ArtifactButton("📸 Screenshots")
            ArtifactButton("🎬 Video")
            ArtifactButton("📱 Snapshot")
        }
    }
}

@Composable
private fun TestStepRow(step: TestStep) {
    val colors = JewelTheme.globalColors
    val statusColor = when (step.status) {
        TestStatus.Passed -> Color(0xFF4CAF50)
        TestStatus.Failed -> Color(0xFFFF5722)
        TestStatus.Running -> Color(0xFF2196F3)
        TestStatus.Skipped -> colors.text.normal.copy(alpha = 0.4f)
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
            .padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Step number
        Text(
            "${step.index + 1}",
            fontSize = 11.sp,
            color = colors.text.normal.copy(alpha = 0.4f),
            modifier = Modifier.width(24.dp),
        )

        // Status indicator
        Box(
            modifier = Modifier.size(6.dp).background(statusColor, CircleShape)
        )

        Spacer(Modifier.width(10.dp))

        // Action details
        Column(modifier = Modifier.weight(1f)) {
            Text(
                "${step.action}: ${step.target}",
                fontSize = 12.sp,
            )
            step.screenName?.let {
                Text(
                    "on $it",
                    fontSize = 10.sp,
                    color = colors.text.normal.copy(alpha = 0.5f),
                )
            }
            step.errorMessage?.let {
                Text(
                    it,
                    fontSize = 10.sp,
                    color = Color(0xFFFF5722),
                )
            }
        }

        // Duration
        Text(
            "${step.durationMs}ms",
            fontSize = 10.sp,
            color = colors.text.normal.copy(alpha = 0.4f),
        )
    }
}

@Composable
private fun ArtifactButton(label: String) {
    val colors = JewelTheme.globalColors

    Box(
        modifier = Modifier
            .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(6.dp))
            .clickable { /* TODO: Open artifact */ }
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Text(label, fontSize = 12.sp)
    }
}
