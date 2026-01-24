package dev.jasonpearson.automobile.ide.failures

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.jetbrains.jewel.foundation.theme.JewelTheme
import org.jetbrains.jewel.ui.component.Text

/**
 * Main Failures dashboard showing crashes, ANRs, and tool call failures
 */
@Composable
fun FailuresDashboard(
    onNavigateToScreen: (String) -> Unit = {},
    onNavigateToTest: (String) -> Unit = {},
    onNavigateToSource: (fileName: String, lineNumber: Int) -> Unit = { _, _ -> },
    modifier: Modifier = Modifier,
) {
    // Mock failure data
    val failureGroups = remember { createMockFailureGroups() }

    var selectedFailure by remember { mutableStateOf<FailureGroup?>(null) }
    var filterType by remember { mutableStateOf<FailureType?>(null) }

    Column(modifier = modifier.fillMaxSize().padding(16.dp)) {
        if (selectedFailure != null) {
            FailureDetailView(
                failure = selectedFailure!!,
                onBack = { selectedFailure = null },
                onNavigateToScreen = onNavigateToScreen,
                onNavigateToTest = onNavigateToTest,
                onNavigateToSource = onNavigateToSource,
            )
        } else {
            FailureListView(
                failures = failureGroups,
                filterType = filterType,
                onFilterChanged = { filterType = it },
                onFailureSelected = { selectedFailure = it },
            )
        }
    }
}

@Composable
private fun FailureListView(
    failures: List<FailureGroup>,
    filterType: FailureType?,
    onFilterChanged: (FailureType?) -> Unit,
    onFailureSelected: (FailureGroup) -> Unit,
) {
    val colors = JewelTheme.globalColors
    val filteredFailures = if (filterType != null) {
        failures.filter { it.type == filterType }
    } else {
        failures
    }

    Column(modifier = Modifier.fillMaxSize()) {
        // Header
        Text("Failures", fontSize = 16.sp, fontWeight = FontWeight.Medium)
        Text(
            "Crashes, ANRs, and tool call failures",
            color = colors.text.normal.copy(alpha = 0.6f),
            fontSize = 12.sp,
            modifier = Modifier.padding(top = 2.dp, bottom = 12.dp),
        )

        // Filter chips
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(bottom = 12.dp),
        ) {
            FilterChip(
                label = "All",
                isSelected = filterType == null,
                onClick = { onFilterChanged(null) },
            )
            FailureType.entries.forEach { type ->
                FilterChip(
                    label = "${type.icon} ${type.label}",
                    isSelected = filterType == type,
                    onClick = { onFilterChanged(type) },
                )
            }
        }

        // Summary stats
        Row(
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            modifier = Modifier.padding(bottom = 16.dp),
        ) {
            StatBox(
                label = "Total",
                value = filteredFailures.sumOf { it.totalCount }.toString(),
                color = colors.text.normal,
            )
            StatBox(
                label = "Critical",
                value = filteredFailures.count { it.severity == FailureSeverity.Critical }.toString(),
                color = FailureSeverity.Critical.color,
            )
            StatBox(
                label = "Last 24h",
                value = filteredFailures.count { System.currentTimeMillis() - it.lastOccurrence < 86400000 }.toString(),
                color = Color(0xFF2196F3),
            )
        }

        // Failure list
        Column(
            verticalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.verticalScroll(rememberScrollState()),
        ) {
            if (filteredFailures.isEmpty()) {
                Box(
                    modifier = Modifier.fillMaxWidth().padding(32.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "No failures found",
                        color = colors.text.normal.copy(alpha = 0.5f),
                    )
                }
            } else {
                filteredFailures.forEach { failure ->
                    FailureListItem(
                        failure = failure,
                        onClick = { onFailureSelected(failure) },
                    )
                }
            }
        }
    }
}

@Composable
private fun FilterChip(
    label: String,
    isSelected: Boolean,
    onClick: () -> Unit,
) {
    val colors = JewelTheme.globalColors
    val bgColor = if (isSelected) colors.text.normal.copy(alpha = 0.15f) else Color.Transparent
    val borderColor = if (isSelected) colors.text.normal.copy(alpha = 0.3f) else colors.text.normal.copy(alpha = 0.2f)

    Box(
        modifier = Modifier
            .background(bgColor, RoundedCornerShape(4.dp))
            .border(1.dp, borderColor, RoundedCornerShape(4.dp))
            .clickable(onClick = onClick)
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text(label, fontSize = 11.sp, maxLines = 1)
    }
}

@Composable
private fun StatBox(
    label: String,
    value: String,
    color: Color,
) {
    val colors = JewelTheme.globalColors

    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            value,
            fontSize = 18.sp,
            fontWeight = FontWeight.Bold,
            color = color,
        )
        Text(
            label,
            fontSize = 10.sp,
            color = colors.text.normal.copy(alpha = 0.5f),
        )
    }
}

@Composable
private fun FailureListItem(
    failure: FailureGroup,
    onClick: () -> Unit,
) {
    val colors = JewelTheme.globalColors

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
            .clickable(onClick = onClick)
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Type icon and severity indicator
        Box(
            modifier = Modifier
                .size(36.dp)
                .background(failure.type.color.copy(alpha = 0.15f), RoundedCornerShape(6.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Text(failure.type.icon, fontSize = 16.sp)
        }

        Spacer(Modifier.width(12.dp))

        // Failure info
        Column(modifier = Modifier.weight(1f)) {
            Text(
                failure.title,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                failure.signature,
                fontSize = 11.sp,
                color = colors.text.normal.copy(alpha = 0.5f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        Spacer(Modifier.width(12.dp))

        // Count and severity
        Column(horizontalAlignment = Alignment.End) {
            Text(
                "${failure.totalCount}x",
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = failure.severity.color,
            )
            Text(
                failure.severity.label,
                fontSize = 10.sp,
                color = failure.severity.color.copy(alpha = 0.7f),
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FailureDetailView(
    failure: FailureGroup,
    onBack: () -> Unit,
    onNavigateToScreen: (String) -> Unit,
    onNavigateToTest: (String) -> Unit,
    onNavigateToSource: (fileName: String, lineNumber: Int) -> Unit,
) {
    val colors = JewelTheme.globalColors
    val event = failure.representativeEvent

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState()),
    ) {
        // Back button and header
        Text(
            "← Back",
            fontSize = 12.sp,
            color = Color(0xFF2196F3),
            modifier = Modifier
                .clickable(onClick = onBack)
                .pointerHoverIcon(PointerIcon.Hand)
                .padding(bottom = 12.dp),
        )

        // Failure header with type badge
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                modifier = Modifier
                    .background(failure.type.color.copy(alpha = 0.15f), RoundedCornerShape(4.dp))
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            ) {
                Text(
                    "${failure.type.icon} ${failure.type.label}",
                    fontSize = 11.sp,
                    color = failure.type.color,
                )
            }
            Box(
                modifier = Modifier
                    .background(failure.severity.color.copy(alpha = 0.15f), RoundedCornerShape(4.dp))
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            ) {
                Text(
                    failure.severity.label,
                    fontSize = 11.sp,
                    color = failure.severity.color,
                )
            }
        }

        Text(
            failure.title,
            fontSize = 16.sp,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(top = 8.dp),
        )
        Text(
            "${failure.totalCount} occurrences",
            fontSize = 12.sp,
            color = colors.text.normal.copy(alpha = 0.5f),
            modifier = Modifier.padding(top = 2.dp, bottom = 16.dp),
        )

        // Screenshot/Video at failure (displayed inline if available)
        if (event.screenshotPath != null || event.videoPath != null) {
            SectionHeader("Failure Capture")
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(200.dp)
                    .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(6.dp)),
                contentAlignment = Alignment.Center,
            ) {
                if (event.videoPath != null) {
                    // Video placeholder - in real impl would use video player
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("🎬", fontSize = 32.sp)
                        Text(
                            "Video: ${event.videoPath.substringAfterLast("/")}",
                            fontSize = 11.sp,
                            color = colors.text.normal.copy(alpha = 0.6f),
                            modifier = Modifier.padding(top = 8.dp),
                        )
                        Text(
                            "Click to play",
                            fontSize = 10.sp,
                            color = Color(0xFF2196F3),
                            modifier = Modifier
                                .padding(top = 4.dp)
                                .clickable { /* TODO: Open video */ }
                                .pointerHoverIcon(PointerIcon.Hand),
                        )
                    }
                } else if (event.screenshotPath != null) {
                    // Screenshot placeholder - in real impl would load image
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("📸", fontSize = 32.sp)
                        Text(
                            "Screenshot: ${event.screenshotPath.substringAfterLast("/")}",
                            fontSize = 11.sp,
                            color = colors.text.normal.copy(alpha = 0.6f),
                            modifier = Modifier.padding(top = 8.dp),
                        )
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
        }

        // Error message
        SectionHeader("Error Message")
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(6.dp))
                .padding(12.dp),
        ) {
            Text(
                event.message,
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
                color = Color(0xFFE53935),
            )
        }

        // Stack trace with clickable lines (if available)
        if (event.stackTraceElements.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            SectionHeader("Stack Trace")
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
                    .padding(8.dp),
            ) {
                event.stackTraceElements.forEach { element ->
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
                        modifier = Modifier
                            .fillMaxWidth()
                            .then(
                                if (isClickable) {
                                    Modifier
                                        .clickable { onNavigateToSource(element.fileName!!, element.lineNumber!!) }
                                        .pointerHoverIcon(PointerIcon.Hand)
                                } else Modifier
                            )
                            .padding(vertical = 2.dp, horizontal = 4.dp),
                    )
                }
            }
        } else if (!event.stackTrace.isNullOrBlank()) {
            // Fallback: raw stack trace if not parsed
            Spacer(Modifier.height(16.dp))
            SectionHeader("Stack Trace")
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
                    .horizontalScroll(rememberScrollState())
                    .padding(12.dp),
            ) {
                Text(
                    event.stackTrace,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    color = colors.text.normal.copy(alpha = 0.8f),
                )
            }
        }

        // Tool call info (for tool failures)
        if (event.toolCallInfo != null) {
            Spacer(Modifier.height(16.dp))
            SectionHeader("Tool Call Details")
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
                    .padding(12.dp),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    DetailRow("Tool", event.toolCallInfo.toolName)
                    event.toolCallInfo.errorCode?.let { DetailRow("Error Code", it) }
                    event.toolCallInfo.duration?.let { DetailRow("Duration", "${it}ms") }
                    if (event.toolCallInfo.parameters.isNotEmpty()) {
                        Text(
                            "Parameters:",
                            fontSize = 11.sp,
                            color = colors.text.normal.copy(alpha = 0.6f),
                            modifier = Modifier.padding(top = 4.dp),
                        )
                        event.toolCallInfo.parameters.forEach { (key, value) ->
                            Text(
                                "  $key: $value",
                                fontSize = 11.sp,
                                fontFamily = FontFamily.Monospace,
                                color = colors.text.normal.copy(alpha = 0.8f),
                            )
                        }
                    }
                }
            }
        }

        // Screens Visited
        if (event.screensVisited.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            SectionHeader("Screens Visited")
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                event.screensVisited.forEachIndexed { index, screen ->
                    val isFailureScreen = screen == event.screenAtFailure
                    ScreenChip(
                        name = screen,
                        isHighlighted = isFailureScreen,
                        onClick = { onNavigateToScreen(screen) },
                    )
                }
            }
            if (event.screenAtFailure != null) {
                Text(
                    "💥 Failure occurred on ${event.screenAtFailure}",
                    fontSize = 11.sp,
                    color = Color(0xFFE53935).copy(alpha = 0.8f),
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        }

        // Related Tests
        if (failure.affectedTests.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            SectionHeader("Affected Tests")
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                failure.affectedTests.forEach { testName ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
                            .clickable { onNavigateToTest(testName) }
                            .pointerHoverIcon(PointerIcon.Hand)
                            .padding(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(testName, fontSize = 12.sp, modifier = Modifier.weight(1f))
                        Text(
                            "View →",
                            fontSize = 11.sp,
                            color = Color(0xFF2196F3),
                        )
                    }
                }
            }
        }

        // Device Info
        Spacer(Modifier.height(16.dp))
        SectionHeader("Device Info")
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
                .padding(12.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                DetailRow("Device", event.deviceInfo.name)
                DetailRow("OS", event.deviceInfo.os)
                DetailRow("App Version", event.deviceInfo.appVersion)
                event.deviceInfo.memoryUsage?.let { DetailRow("Memory", it) }
                event.deviceInfo.cpuUsage?.let { DetailRow("CPU", it) }
            }
        }

        // Action Buttons
        Spacer(Modifier.height(24.dp))
        SectionHeader("Actions")
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                ActionCard(
                    icon = "📋",
                    title = "Copy Logs",
                    description = "Copy full logs to clipboard",
                    modifier = Modifier.weight(1f),
                    onClick = { /* TODO */ },
                )
                ActionCard(
                    icon = "📦",
                    title = "Export Bundle",
                    description = "Save debug bundle to file",
                    modifier = Modifier.weight(1f),
                    onClick = { /* TODO */ },
                )
            }
            ActionCard(
                icon = "🔄",
                title = "Reproduce Failure",
                description = "Replay test steps up to failure point",
                modifier = Modifier.fillMaxWidth(),
                onClick = { /* TODO */ },
            )
        }

        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun SectionHeader(title: String) {
    val colors = JewelTheme.globalColors
    Text(
        title,
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
        color = colors.text.normal.copy(alpha = 0.7f),
        modifier = Modifier.padding(bottom = 8.dp),
    )
}

@Composable
private fun DetailRow(label: String, value: String) {
    val colors = JewelTheme.globalColors
    Row {
        Text(
            "$label: ",
            fontSize = 11.sp,
            color = colors.text.normal.copy(alpha = 0.5f),
        )
        Text(
            value,
            fontSize = 11.sp,
            color = colors.text.normal.copy(alpha = 0.9f),
        )
    }
}

@Composable
private fun ScreenChip(
    name: String,
    isHighlighted: Boolean,
    onClick: () -> Unit,
) {
    val colors = JewelTheme.globalColors
    val bgColor = if (isHighlighted) Color(0xFFE53935).copy(alpha = 0.15f) else colors.text.normal.copy(alpha = 0.08f)
    val borderColor = if (isHighlighted) Color(0xFFE53935).copy(alpha = 0.5f) else colors.text.normal.copy(alpha = 0.2f)
    val textColor = if (isHighlighted) Color(0xFFE53935) else colors.text.normal

    Box(
        modifier = Modifier
            .background(bgColor, RoundedCornerShape(4.dp))
            .border(1.dp, borderColor, RoundedCornerShape(4.dp))
            .clickable(onClick = onClick)
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Text(name, fontSize = 12.sp, color = textColor)
    }
}

@Composable
private fun ActionCard(
    icon: String,
    title: String,
    description: String,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val colors = JewelTheme.globalColors

    Row(
        modifier = modifier
            .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(icon, fontSize = 24.sp)
        Spacer(Modifier.width(12.dp))
        Column {
            Text(
                title,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
            )
            Text(
                description,
                fontSize = 10.sp,
                color = colors.text.normal.copy(alpha = 0.5f),
            )
        }
    }
}

/**
 * Create mock failure data for demonstration
 *
 * Severity is calculated based on:
 * - Critical: >20 occurrences OR crash in critical flow (login, checkout, etc.)
 * - High: 10-20 occurrences OR ANR
 * - Medium: 5-10 occurrences
 * - Low: <5 occurrences
 */
private fun createMockFailureGroups(): List<FailureGroup> {
    return listOf(
        FailureGroup(
            id = "crash-1",
            type = FailureType.Crash,
            signature = "NullPointerException at LoginViewModel.kt:42",
            title = "NullPointerException in LoginViewModel",
            firstOccurrence = System.currentTimeMillis() - 86400000 * 3,
            lastOccurrence = System.currentTimeMillis() - 3600000,
            totalCount = 23,
            affectedTests = listOf("testLoginFlow", "testSignupValidation"),
            severity = FailureSeverity.Critical, // >20 occurrences + critical flow
            representativeEvent = FailureEvent(
                id = "event-1",
                type = FailureType.Crash,
                title = "NullPointerException in LoginViewModel",
                message = "java.lang.NullPointerException: Attempt to invoke virtual method 'String com.example.User.getName()' on a null object reference",
                stackTrace = null, // Using parsed elements instead
                stackTraceElements = listOf(
                    StackTraceElement("com.example.app.LoginViewModel", "validateUser", "LoginViewModel.kt", 42, isAppCode = true),
                    StackTraceElement("com.example.app.LoginViewModel", "onLoginClicked", "LoginViewModel.kt", 28, isAppCode = true),
                    StackTraceElement("com.example.app.LoginFragment", "onClick", "LoginFragment.kt", 67, isAppCode = true),
                    StackTraceElement("android.view.View", "performClick", "View.java", 7448, isAppCode = false),
                    StackTraceElement("android.widget.Button", "performClick", "Button.java", 188, isAppCode = false),
                ),
                timestamp = System.currentTimeMillis() - 3600000,
                screenAtFailure = "Login",
                screensVisited = listOf("Splash", "Login"),
                relatedTestName = "testLoginFlow",
                deviceInfo = DeviceInfo(
                    name = "Pixel 8 API 35",
                    os = "Android 15",
                    appVersion = "2.4.1-debug",
                    memoryUsage = "156 MB / 512 MB",
                    cpuUsage = "23%",
                ),
                screenshotPath = "/captures/crash-1/screenshot.png",
            ),
        ),
        FailureGroup(
            id = "anr-1",
            type = FailureType.ANR,
            signature = "ANR in HomeFragment.onResume",
            title = "ANR: Main thread blocked",
            firstOccurrence = System.currentTimeMillis() - 86400000 * 2,
            lastOccurrence = System.currentTimeMillis() - 7200000,
            totalCount = 8,
            affectedTests = listOf("testHomeLoad", "testProfileEdit"),
            severity = FailureSeverity.High, // ANR = High severity
            representativeEvent = FailureEvent(
                id = "event-2",
                type = FailureType.ANR,
                title = "ANR: Main thread blocked",
                message = "Application Not Responding: Main thread blocked for 5+ seconds during database query",
                stackTrace = null,
                stackTraceElements = listOf(
                    StackTraceElement("com.example.app.data.UserDao", "getAllUsers", "UserDao.kt", 23, isAppCode = true),
                    StackTraceElement("com.example.app.HomeViewModel", "loadUsers", "HomeViewModel.kt", 45, isAppCode = true),
                    StackTraceElement("com.example.app.HomeFragment", "onResume", "HomeFragment.kt", 31, isAppCode = true),
                    StackTraceElement("androidx.fragment.app.Fragment", "performResume", "Fragment.java", 3135, isAppCode = false),
                ),
                timestamp = System.currentTimeMillis() - 7200000,
                screenAtFailure = "Home",
                screensVisited = listOf("Splash", "Login", "Home"),
                relatedTestName = "testHomeLoad",
                deviceInfo = DeviceInfo(
                    name = "Pixel 7 API 34",
                    os = "Android 14",
                    appVersion = "2.4.1-debug",
                    memoryUsage = "234 MB / 512 MB",
                    cpuUsage = "89%",
                ),
                videoPath = "/captures/anr-1/recording.mp4",
            ),
        ),
        FailureGroup(
            id = "tool-1",
            type = FailureType.ToolCallFailure,
            signature = "tapOn failed: Element not found",
            title = "tapOn: Element 'Submit' not found",
            firstOccurrence = System.currentTimeMillis() - 86400000,
            lastOccurrence = System.currentTimeMillis() - 1800000,
            totalCount = 12,
            affectedTests = listOf("testFormSubmission", "testCheckout"),
            severity = FailureSeverity.Medium, // 10-20 occurrences
            representativeEvent = FailureEvent(
                id = "event-3",
                type = FailureType.ToolCallFailure,
                title = "tapOn: Element 'Submit' not found",
                message = "Element with text 'Submit' not found within 5000ms timeout. Found elements: ['Cancel', 'Back', 'Save Draft']",
                stackTrace = null,
                timestamp = System.currentTimeMillis() - 1800000,
                screenAtFailure = "Checkout",
                screensVisited = listOf("Home", "Cart", "Checkout"),
                relatedTestName = "testCheckout",
                deviceInfo = DeviceInfo(
                    name = "iPhone 15 Pro",
                    os = "iOS 17.2",
                    appVersion = "2.4.0",
                ),
                toolCallInfo = ToolCallInfo(
                    toolName = "tapOn",
                    parameters = mapOf(
                        "text" to "Submit",
                        "timeout" to "5000",
                    ),
                    errorCode = "ELEMENT_NOT_FOUND",
                    duration = 5023,
                ),
                screenshotPath = "/captures/tool-1/screenshot.png",
            ),
        ),
        FailureGroup(
            id = "crash-2",
            type = FailureType.Crash,
            signature = "IndexOutOfBoundsException at RecyclerView",
            title = "IndexOutOfBoundsException in MessageList",
            firstOccurrence = System.currentTimeMillis() - 86400000 * 5,
            lastOccurrence = System.currentTimeMillis() - 86400000,
            totalCount = 5,
            affectedTests = listOf("testSendMessage"),
            severity = FailureSeverity.Low, // <5 occurrences, not recent
            representativeEvent = FailureEvent(
                id = "event-4",
                type = FailureType.Crash,
                title = "IndexOutOfBoundsException in MessageList",
                message = "java.lang.IndexOutOfBoundsException: Inconsistency detected. Invalid view holder adapter position",
                stackTrace = null,
                stackTraceElements = listOf(
                    StackTraceElement("androidx.recyclerview.widget.RecyclerView", "findViewHolderForPosition", "RecyclerView.java", 1345, isAppCode = false),
                    StackTraceElement("com.example.app.MessageListAdapter", "onBindViewHolder", "MessageListAdapter.kt", 67, isAppCode = true),
                ),
                timestamp = System.currentTimeMillis() - 86400000,
                screenAtFailure = "Messages",
                screensVisited = listOf("Home", "Messages"),
                relatedTestName = "testSendMessage",
                deviceInfo = DeviceInfo(
                    name = "Pixel 8 API 35",
                    os = "Android 15",
                    appVersion = "2.4.1-debug",
                ),
            ),
        ),
    )
}
