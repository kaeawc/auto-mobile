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

/**
 * Date range options for the timeline
 */
private enum class DateRange(val label: String, val durationMs: Long) {
    OneHour("1h", 60 * 60 * 1000L),
    TwentyFourHours("24h", 24 * 60 * 60 * 1000L),
    ThreeDays("3d", 3 * 24 * 60 * 60 * 1000L),
    SevenDays("7d", 7 * 24 * 60 * 60 * 1000L),
    ThirtyDays("30d", 30 * 24 * 60 * 60 * 1000L),
}

/**
 * Time aggregation options for the timeline
 */
private enum class TimeAggregation(val label: String) {
    Minute("Min"),
    Hour("Hour"),
    Day("Day"),
    Week("Week"),
}

/**
 * Data point for timeline chart
 */
private data class TimelineDataPoint(
    val label: String,
    val crashes: Int,
    val anrs: Int,
    val toolFailures: Int,
) {
    val total: Int get() = crashes + anrs + toolFailures
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

    var dateRange by remember { mutableStateOf(DateRange.TwentyFourHours) }
    var timeAggregation by remember { mutableStateOf(TimeAggregation.Hour) }
    val timelineData = remember(dateRange, timeAggregation) { generateMockTimelineData(dateRange, timeAggregation) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState()),
    ) {
        // Date range and aggregation selectors
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Date range selector
            Row(
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier
                    .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(6.dp))
                    .padding(4.dp),
            ) {
                DateRange.entries.forEach { range ->
                    val isSelected = range == dateRange
                    Box(
                        modifier = Modifier
                            .background(
                                if (isSelected) colors.text.normal.copy(alpha = 0.15f) else Color.Transparent,
                                RoundedCornerShape(4.dp),
                            )
                            .clickable { dateRange = range }
                            .pointerHoverIcon(PointerIcon.Hand)
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                    ) {
                        Text(
                            range.label,
                            fontSize = 10.sp,
                            color = if (isSelected) colors.text.normal else colors.text.normal.copy(alpha = 0.6f),
                        )
                    }
                }
            }

            // Aggregation selector
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "Group by:",
                    fontSize = 10.sp,
                    color = colors.text.normal.copy(alpha = 0.5f),
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    modifier = Modifier
                        .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(6.dp))
                        .padding(4.dp),
                ) {
                    TimeAggregation.entries.forEach { agg ->
                        val isSelected = agg == timeAggregation
                        Box(
                            modifier = Modifier
                                .background(
                                    if (isSelected) colors.text.normal.copy(alpha = 0.15f) else Color.Transparent,
                                    RoundedCornerShape(4.dp),
                                )
                                .clickable { timeAggregation = agg }
                                .pointerHoverIcon(PointerIcon.Hand)
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        ) {
                            Text(
                                agg.label,
                                fontSize = 10.sp,
                                color = if (isSelected) colors.text.normal else colors.text.normal.copy(alpha = 0.6f),
                            )
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(16.dp))

        // Event Trends section
        EventTrendsSection(
            data = timelineData,
            dateRange = dateRange,
            aggregation = timeAggregation,
        )

        Spacer(Modifier.height(16.dp))

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

        // Issues header
        Text(
            "Issues (${filteredFailures.size})",
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            color = colors.text.normal.copy(alpha = 0.7f),
            modifier = Modifier.padding(bottom = 8.dp),
        )

        // Failure list
        Column(
            verticalArrangement = Arrangement.spacedBy(8.dp),
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
    delta: String? = null,
    deltaPositive: Boolean = false,
) {
    val colors = JewelTheme.globalColors

    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            value,
            fontSize = 18.sp,
            fontWeight = FontWeight.Bold,
            color = color,
        )
        if (delta != null) {
            Text(
                delta,
                fontSize = 9.sp,
                color = if (deltaPositive) Color(0xFF4CAF50) else Color(0xFFE53935),
            )
        }
        Text(
            label,
            fontSize = 10.sp,
            color = colors.text.normal.copy(alpha = 0.5f),
        )
    }
}

@Composable
private fun EventTrendsSection(
    data: List<TimelineDataPoint>,
    dateRange: DateRange,
    aggregation: TimeAggregation,
) {
    val colors = JewelTheme.globalColors

    // Calculate totals and deltas
    val totalCrashes = data.sumOf { it.crashes }
    val totalAnrs = data.sumOf { it.anrs }
    val totalToolFailures = data.sumOf { it.toolFailures }

    // Calculate delta (compare first half to second half as a simple approximation)
    val halfPoint = data.size / 2
    val recentCrashes = data.takeLast(halfPoint).sumOf { it.crashes }
    val olderCrashes = data.take(halfPoint).sumOf { it.crashes }
    val crashDelta = if (olderCrashes > 0) ((recentCrashes - olderCrashes) * 100 / olderCrashes) else 0

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(8.dp))
            .padding(12.dp),
    ) {
        // Stats row
        Row(
            horizontalArrangement = Arrangement.SpaceEvenly,
            modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp),
        ) {
            StatBox(
                label = "Crashes",
                value = totalCrashes.toString(),
                color = FailureType.Crash.color,
                delta = if (crashDelta != 0) "${if (crashDelta > 0) "+" else ""}$crashDelta%" else null,
                deltaPositive = crashDelta < 0,
            )
            StatBox(
                label = "ANRs",
                value = totalAnrs.toString(),
                color = FailureType.ANR.color,
            )
            StatBox(
                label = "Tool Errors",
                value = totalToolFailures.toString(),
                color = FailureType.ToolCallFailure.color,
            )
            StatBox(
                label = "Total",
                value = (totalCrashes + totalAnrs + totalToolFailures).toString(),
                color = colors.text.normal,
            )
        }

        // Bar chart
        FailureBarChart(data = data, aggregation = aggregation)
    }
}

@Composable
private fun FailureBarChart(
    data: List<TimelineDataPoint>,
    aggregation: TimeAggregation,
) {
    val colors = JewelTheme.globalColors
    val maxValue = data.maxOfOrNull { it.total } ?: 1
    val chartHeight = 80.dp

    Column {
        // Bars
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(chartHeight),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            data.forEach { point ->
                val barHeight = if (maxValue > 0) (point.total.toFloat() / maxValue) else 0f

                Column(
                    modifier = Modifier
                        .weight(1f)
                        .height(chartHeight),
                    verticalArrangement = Arrangement.Bottom,
                ) {
                    // Stacked bar: crashes (red) + ANRs (orange) + tool failures (purple)
                    if (point.total > 0) {
                        val crashHeight = point.crashes.toFloat() / point.total * barHeight
                        val anrHeight = point.anrs.toFloat() / point.total * barHeight
                        val toolHeight = point.toolFailures.toFloat() / point.total * barHeight

                        if (point.toolFailures > 0) {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height((chartHeight.value * toolHeight).dp)
                                    .background(
                                        FailureType.ToolCallFailure.color.copy(alpha = 0.8f),
                                        RoundedCornerShape(topStart = 2.dp, topEnd = 2.dp),
                                    ),
                            )
                        }
                        if (point.anrs > 0) {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height((chartHeight.value * anrHeight).dp)
                                    .background(FailureType.ANR.color.copy(alpha = 0.8f)),
                            )
                        }
                        if (point.crashes > 0) {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height((chartHeight.value * crashHeight).dp)
                                    .background(
                                        FailureType.Crash.color.copy(alpha = 0.8f),
                                        RoundedCornerShape(bottomStart = 2.dp, bottomEnd = 2.dp),
                                    ),
                            )
                        }
                    }
                }
            }
        }

        // X-axis labels (show every few labels to avoid crowding)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            val labelStep = when {
                data.size <= 7 -> 1
                data.size <= 14 -> 2
                data.size <= 24 -> 4
                else -> 10
            }
            data.filterIndexed { index, _ -> index % labelStep == 0 || index == data.lastIndex }
                .forEach { point ->
                    Text(
                        point.label,
                        fontSize = 8.sp,
                        color = colors.text.normal.copy(alpha = 0.4f),
                    )
                }
        }
    }
}

/**
 * Generate mock timeline data with relative time labels
 */
private fun generateMockTimelineData(dateRange: DateRange, aggregation: TimeAggregation): List<TimelineDataPoint> {
    val random = kotlin.random.Random(42) // Fixed seed for consistent data

    // Calculate bucket duration and count based on aggregation
    val bucketDurationMs = when (aggregation) {
        TimeAggregation.Minute -> 60 * 1000L
        TimeAggregation.Hour -> 60 * 60 * 1000L
        TimeAggregation.Day -> 24 * 60 * 60 * 1000L
        TimeAggregation.Week -> 7 * 24 * 60 * 60 * 1000L
    }

    // Calculate number of buckets - cap at reasonable display limit
    val maxBuckets = when (aggregation) {
        TimeAggregation.Minute -> 120  // Up to 2 hours of minute data
        TimeAggregation.Hour -> 168    // Up to 7 days of hourly data
        TimeAggregation.Day -> 60      // Up to 60 days
        TimeAggregation.Week -> 52     // Up to 52 weeks
    }
    val buckets = (dateRange.durationMs / bucketDurationMs).toInt().coerceIn(1, maxBuckets)

    return (0 until buckets).map { i ->
        // Calculate time offset from now (bucket 0 is most recent)
        val bucketIndex = buckets - 1 - i  // Reverse so oldest first
        val timeAgoMs = bucketIndex * bucketDurationMs

        // Generate relative time label
        val label = formatRelativeTimeLabel(timeAgoMs, aggregation)

        // Generate realistic-looking failure data with some variance
        val baseCrashes = when (aggregation) {
            TimeAggregation.Minute -> random.nextInt(0, 5)
            TimeAggregation.Hour -> random.nextInt(2, 15)
            TimeAggregation.Day -> random.nextInt(10, 50)
            TimeAggregation.Week -> random.nextInt(30, 150)
        }
        val baseAnrs = baseCrashes / 3
        val baseToolFailures = baseCrashes / 2

        TimelineDataPoint(
            label = label,
            crashes = baseCrashes,
            anrs = baseAnrs,
            toolFailures = baseToolFailures,
        )
    }
}

/**
 * Format a relative time label for the timeline
 */
private fun formatRelativeTimeLabel(timeAgoMs: Long, aggregation: TimeAggregation): String {
    val minutes = timeAgoMs / (60 * 1000)
    val hours = timeAgoMs / (60 * 60 * 1000)
    val days = timeAgoMs / (24 * 60 * 60 * 1000)
    val weeks = timeAgoMs / (7 * 24 * 60 * 60 * 1000)

    return when (aggregation) {
        TimeAggregation.Minute -> {
            if (minutes == 0L) "now" else "${minutes}m"
        }
        TimeAggregation.Hour -> {
            if (hours == 0L) "now" else "${hours}h"
        }
        TimeAggregation.Day -> {
            // Show actual date
            val now = System.currentTimeMillis()
            val dayMs = now - timeAgoMs
            val calendar = java.util.Calendar.getInstance()
            calendar.timeInMillis = dayMs
            val month = calendar.getDisplayName(java.util.Calendar.MONTH, java.util.Calendar.SHORT, java.util.Locale.getDefault()) ?: ""
            val day = calendar.get(java.util.Calendar.DAY_OF_MONTH)
            "$month $day"
        }
        TimeAggregation.Week -> {
            // Calculate the Monday of the week
            val now = System.currentTimeMillis()
            val weekStartMs = now - timeAgoMs
            val calendar = java.util.Calendar.getInstance()
            calendar.timeInMillis = weekStartMs
            // Adjust to Monday of that week
            val dayOfWeek = calendar.get(java.util.Calendar.DAY_OF_WEEK)
            val daysToMonday = if (dayOfWeek == java.util.Calendar.SUNDAY) -6 else java.util.Calendar.MONDAY - dayOfWeek
            calendar.add(java.util.Calendar.DAY_OF_MONTH, daysToMonday)

            val month = calendar.getDisplayName(java.util.Calendar.MONTH, java.util.Calendar.SHORT, java.util.Locale.getDefault()) ?: ""
            val day = calendar.get(java.util.Calendar.DAY_OF_MONTH)
            "$month $day"
        }
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

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState()),
    ) {
        // Back button
        Text(
            "← Back",
            fontSize = 12.sp,
            color = Color(0xFF2196F3),
            modifier = Modifier
                .clickable(onClick = onBack)
                .pointerHoverIcon(PointerIcon.Hand)
                .padding(bottom = 12.dp),
        )

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

        // Captures gallery (if available)
        if (failure.recentCaptures.isNotEmpty()) {
            SectionHeader("Captures (${failure.recentCaptures.size})")
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.horizontalScroll(rememberScrollState()),
            ) {
                failure.recentCaptures.take(5).forEach { capture ->
                    CaptureCard(capture = capture)
                }
            }
            if (failure.recentCaptures.size > 5) {
                ViewAllLink("View all ${failure.recentCaptures.size} captures") { /* TODO: Show all captures */ }
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
                failure.message,
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
                color = Color(0xFFE53935),
            )
        }

        // Stack trace with clickable lines
        if (failure.stackTraceElements.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            SectionHeader("Stack Trace")
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
                    .padding(8.dp),
            ) {
                failure.stackTraceElements.forEach { element ->
                    StackTraceLine(element = element, onNavigateToSource = onNavigateToSource)
                }
            }
        }

        // Tool call info (for tool failures)
        if (failure.toolCallInfo != null) {
            Spacer(Modifier.height(16.dp))
            SectionHeader("Tool Call Details")
            ToolCallDetailsSection(toolCallInfo = failure.toolCallInfo)
        }

        // Screen breakdown histogram
        if (failure.screenBreakdown.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            SectionHeader("Screens Visited (across ${failure.totalCount} occurrences)")
            ScreenBreakdownSection(
                breakdown = failure.screenBreakdown.take(5),
                failureScreens = failure.failureScreens,
                onNavigateToScreen = onNavigateToScreen,
            )
            if (failure.screenBreakdown.size > 5) {
                ViewAllLink("View all ${failure.screenBreakdown.size} screens") { /* TODO: Show all screens */ }
            }
        }

        // Device breakdown
        if (failure.deviceBreakdown.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            SectionHeader("Devices (${failure.deviceBreakdown.size} models)")
            BreakdownList(
                items = failure.deviceBreakdown.take(5).map { device ->
                    BreakdownItem(
                        label = device.deviceModel,
                        sublabel = device.os,
                        count = device.count,
                        percentage = device.percentage,
                    )
                },
            )
            if (failure.deviceBreakdown.size > 5) {
                ViewAllLink("View all ${failure.deviceBreakdown.size} devices") { /* TODO: Show all devices */ }
            }
        }

        // Version breakdown
        if (failure.versionBreakdown.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            SectionHeader("App Versions (${failure.versionBreakdown.size})")
            BreakdownList(
                items = failure.versionBreakdown.take(5).map { version ->
                    BreakdownItem(
                        label = version.version,
                        sublabel = null,
                        count = version.count,
                        percentage = version.percentage,
                    )
                },
            )
            if (failure.versionBreakdown.size > 5) {
                ViewAllLink("View all ${failure.versionBreakdown.size} versions") { /* TODO: Show all versions */ }
            }
        }

        // Affected tests
        if (failure.affectedTests.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            SectionHeader("Affected Tests (${failure.affectedTests.size})")
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                failure.affectedTests.entries.sortedByDescending { it.value }.take(5).forEach { (testName, count) ->
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
                            "${count}x",
                            fontSize = 11.sp,
                            color = colors.text.normal.copy(alpha = 0.5f),
                            modifier = Modifier.padding(end = 8.dp),
                        )
                        Text("View →", fontSize = 11.sp, color = Color(0xFF2196F3))
                    }
                }
                if (failure.affectedTests.size > 5) {
                    ViewAllLink("View all ${failure.affectedTests.size} tests") { /* TODO: Show all tests */ }
                }
            }
        }

        // Recent occurrences for drill-down
        if (failure.sampleOccurrences.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            SectionHeader("Recent Occurrences")
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                failure.sampleOccurrences.take(5).forEach { occurrence ->
                    OccurrenceRow(occurrence = occurrence)
                }
                if (failure.sampleOccurrences.size > 5) {
                    ViewAllLink("View all ${failure.totalCount} occurrences") { /* TODO: Show all */ }
                }
            }
        }

        // Actions
        Spacer(Modifier.height(24.dp))
        SectionHeader("Actions")
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                ActionCard("📋", "Copy Logs", "All ${failure.totalCount} occurrences", Modifier.weight(1f)) {}
                ActionCard("📦", "Export Bundle", "Debug data package", Modifier.weight(1f)) {}
            }
            ActionCard("🔄", "Reproduce", "Replay test to failure point", Modifier.fillMaxWidth()) {}
        }

        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun Badge(text: String, color: Color) {
    Box(
        modifier = Modifier
            .background(color.copy(alpha = 0.15f), RoundedCornerShape(4.dp))
            .padding(horizontal = 8.dp, vertical = 4.dp),
    ) {
        Text(text, fontSize = 11.sp, color = color)
    }
}

@Composable
private fun CaptureCard(capture: FailureCapture) {
    val colors = JewelTheme.globalColors
    val icon = if (capture.type == CaptureType.Video) "🎬" else "📸"

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .width(100.dp)
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
private fun StackTraceLine(
    element: StackTraceElement,
    onNavigateToSource: (String, Int) -> Unit,
) {
    val colors = JewelTheme.globalColors
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
                if (isClickable) Modifier
                    .clickable { onNavigateToSource(element.fileName!!, element.lineNumber!!) }
                    .pointerHoverIcon(PointerIcon.Hand)
                else Modifier
            )
            .padding(vertical = 2.dp, horizontal = 4.dp),
    )
}

@Composable
private fun ToolCallDetailsSection(toolCallInfo: AggregatedToolCallInfo) {
    val colors = JewelTheme.globalColors

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        DetailRow("Tool", toolCallInfo.toolName)

        // Error codes breakdown
        if (toolCallInfo.errorCodes.isNotEmpty()) {
            Text("Error Codes:", fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.6f))
            val sortedCodes = toolCallInfo.errorCodes.entries.sortedByDescending { it.value }
            sortedCodes.take(5).forEach { (code, count) ->
                Row(modifier = Modifier.padding(start = 8.dp)) {
                    Text(code, fontSize = 11.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                    Text("${count}x", fontSize = 10.sp, color = colors.text.normal.copy(alpha = 0.5f))
                }
            }
            if (sortedCodes.size > 5) {
                ViewAllLink("View all ${sortedCodes.size} error codes") { /* TODO: Show all error codes */ }
            }
        }

        // Duration stats
        if (toolCallInfo.durationStats != null) {
            Text("Duration:", fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.6f))
            Row(
                horizontalArrangement = Arrangement.SpaceEvenly,
                modifier = Modifier.fillMaxWidth(),
            ) {
                DurationStat("Min", toolCallInfo.durationStats.minMs)
                DurationStat("Avg", toolCallInfo.durationStats.avgMs)
                DurationStat("P95", toolCallInfo.durationStats.p95Ms)
                DurationStat("Max", toolCallInfo.durationStats.maxMs)
            }
        }

        // Parameter variants
        if (toolCallInfo.parameterVariants.isNotEmpty()) {
            Text("Parameters:", fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.6f))
            val params = toolCallInfo.parameterVariants.entries.toList()
            params.take(5).forEach { (param, values) ->
                Row(modifier = Modifier.padding(start = 8.dp)) {
                    Text("$param: ", fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.5f))
                    Text(
                        if (values.size == 1) values.first() else "${values.size} variants",
                        fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
            if (params.size > 5) {
                ViewAllLink("View all ${params.size} parameters") { /* TODO: Show all parameters */ }
            }
        }
    }
}

@Composable
private fun DurationStat(label: String, ms: Long) {
    val colors = JewelTheme.globalColors
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text("${ms}ms", fontSize = 12.sp, fontWeight = FontWeight.Medium)
        Text(label, fontSize = 9.sp, color = colors.text.normal.copy(alpha = 0.5f))
    }
}

@Composable
private fun ScreenBreakdownSection(
    breakdown: List<ScreenBreakdown>,
    failureScreens: Map<String, Int>,
    onNavigateToScreen: (String) -> Unit,
) {
    val colors = JewelTheme.globalColors
    val maxVisits = breakdown.maxOfOrNull { it.visitCount } ?: 1

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        breakdown.sortedByDescending { it.visitCount }.forEach { screen ->
            val failureCount = failureScreens[screen.screenName] ?: 0
            val isFailureScreen = failureCount > 0

            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
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
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(16.dp)
                        .padding(horizontal = 8.dp),
                ) {
                    // Visit bar
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(screen.visitCount.toFloat() / maxVisits)
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

private data class BreakdownItem(
    val label: String,
    val sublabel: String?,
    val count: Int,
    val percentage: Float,
)

@Composable
private fun BreakdownList(items: List<BreakdownItem>) {
    val colors = JewelTheme.globalColors

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items.sortedByDescending { it.count }.forEach { item ->
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
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(12.dp)
                        .padding(horizontal = 8.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(item.percentage / 100f)
                            .height(12.dp)
                            .background(Color(0xFF2196F3).copy(alpha = 0.4f), RoundedCornerShape(2.dp)),
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
private fun OccurrenceRow(occurrence: FailureOccurrence) {
    val colors = JewelTheme.globalColors
    val timeAgo = formatTimeAgo(occurrence.timestamp)

    Row(
        modifier = Modifier
            .fillMaxWidth()
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

private fun formatTimeAgo(timestamp: Long): String {
    val diff = System.currentTimeMillis() - timestamp
    return when {
        diff < 60_000 -> "Just now"
        diff < 3600_000 -> "${diff / 60_000}m ago"
        diff < 86400_000 -> "${diff / 3600_000}h ago"
        else -> "${diff / 86400_000}d ago"
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
private fun ViewAllLink(
    text: String,
    onClick: () -> Unit,
) {
    Text(
        "$text →",
        fontSize = 11.sp,
        color = Color(0xFF2196F3),
        modifier = Modifier
            .clickable(onClick = onClick)
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(top = 8.dp, bottom = 4.dp),
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
 * Create mock failure data for demonstration with aggregated data across multiple occurrences
 */
private fun createMockFailureGroups(): List<FailureGroup> {
    val now = System.currentTimeMillis()

    return listOf(
        // Crash with data from multiple devices, versions, and sessions
        FailureGroup(
            id = "crash-1",
            type = FailureType.Crash,
            signature = "NullPointerException at LoginViewModel.kt:42",
            title = "NullPointerException in LoginViewModel",
            message = "java.lang.NullPointerException: Attempt to invoke virtual method 'String com.example.User.getName()' on a null object reference",
            firstOccurrence = now - 86400000 * 3,
            lastOccurrence = now - 3600000,
            totalCount = 23,
            uniqueSessions = 18,
            severity = FailureSeverity.Critical,
            deviceBreakdown = listOf(
                DeviceBreakdown("Pixel 8", "Android 15", 9, 39f),
                DeviceBreakdown("Pixel 7", "Android 14", 6, 26f),
                DeviceBreakdown("Samsung S24", "Android 14", 5, 22f),
                DeviceBreakdown("OnePlus 12", "Android 14", 3, 13f),
            ),
            versionBreakdown = listOf(
                VersionBreakdown("2.4.1-debug", 15, 65f),
                VersionBreakdown("2.4.0", 6, 26f),
                VersionBreakdown("2.3.9", 2, 9f),
            ),
            screenBreakdown = listOf(
                ScreenBreakdown("Splash", 23, 0, 100f),
                ScreenBreakdown("Login", 23, 23, 100f),
            ),
            failureScreens = mapOf("Login" to 23),
            stackTraceElements = listOf(
                StackTraceElement("com.example.app.LoginViewModel", "validateUser", "LoginViewModel.kt", 42, true),
                StackTraceElement("com.example.app.LoginViewModel", "onLoginClicked", "LoginViewModel.kt", 28, true),
                StackTraceElement("com.example.app.LoginFragment", "onClick", "LoginFragment.kt", 67, true),
                StackTraceElement("android.view.View", "performClick", "View.java", 7448, false),
            ),
            toolCallInfo = null,
            affectedTests = mapOf("testLoginFlow" to 15, "testSignupValidation" to 8),
            recentCaptures = listOf(
                FailureCapture("cap-1", CaptureType.Screenshot, "/captures/crash-1/1.png", now - 3600000, "Pixel 8"),
                FailureCapture("cap-2", CaptureType.Screenshot, "/captures/crash-1/2.png", now - 7200000, "Samsung S24"),
                FailureCapture("cap-3", CaptureType.Video, "/captures/crash-1/3.mp4", now - 10800000, "Pixel 7"),
            ),
            sampleOccurrences = listOf(
                FailureOccurrence("occ-1", now - 3600000, "Pixel 8", "Android 15", "2.4.1-debug", "session-1", "Login", listOf("Splash", "Login"), "testLoginFlow", "/captures/crash-1/1.png", CaptureType.Screenshot),
                FailureOccurrence("occ-2", now - 7200000, "Samsung S24", "Android 14", "2.4.1-debug", "session-2", "Login", listOf("Splash", "Login"), "testLoginFlow", "/captures/crash-1/2.png", CaptureType.Screenshot),
                FailureOccurrence("occ-3", now - 10800000, "Pixel 7", "Android 14", "2.4.0", "session-3", "Login", listOf("Splash", "Login"), "testSignupValidation", "/captures/crash-1/3.mp4", CaptureType.Video),
                FailureOccurrence("occ-4", now - 14400000, "OnePlus 12", "Android 14", "2.4.1-debug", "session-4", "Login", listOf("Splash", "Login"), "testLoginFlow", null, null),
                FailureOccurrence("occ-5", now - 18000000, "Pixel 8", "Android 15", "2.4.0", "session-5", "Login", listOf("Splash", "Login"), "testSignupValidation", null, null),
                FailureOccurrence("occ-6", now - 21600000, "Pixel 7", "Android 14", "2.3.9", "session-6", "Login", listOf("Splash", "Login"), "testLoginFlow", null, null),
            ),
        ),

        // ANR with multiple occurrences
        FailureGroup(
            id = "anr-1",
            type = FailureType.ANR,
            signature = "ANR in HomeFragment.onResume",
            title = "ANR: Main thread blocked during DB query",
            message = "Application Not Responding: Main thread blocked for 5+ seconds during database query",
            firstOccurrence = now - 86400000 * 2,
            lastOccurrence = now - 7200000,
            totalCount = 8,
            uniqueSessions = 7,
            severity = FailureSeverity.High,
            deviceBreakdown = listOf(
                DeviceBreakdown("Pixel 7", "Android 14", 4, 50f),
                DeviceBreakdown("Pixel 6", "Android 13", 3, 37f),
                DeviceBreakdown("Samsung A54", "Android 13", 1, 13f),
            ),
            versionBreakdown = listOf(
                VersionBreakdown("2.4.1-debug", 6, 75f),
                VersionBreakdown("2.4.0", 2, 25f),
            ),
            screenBreakdown = listOf(
                ScreenBreakdown("Splash", 8, 0, 100f),
                ScreenBreakdown("Login", 8, 0, 100f),
                ScreenBreakdown("Home", 8, 8, 100f),
            ),
            failureScreens = mapOf("Home" to 8),
            stackTraceElements = listOf(
                StackTraceElement("com.example.app.data.UserDao", "getAllUsers", "UserDao.kt", 23, true),
                StackTraceElement("com.example.app.HomeViewModel", "loadUsers", "HomeViewModel.kt", 45, true),
                StackTraceElement("com.example.app.HomeFragment", "onResume", "HomeFragment.kt", 31, true),
                StackTraceElement("androidx.fragment.app.Fragment", "performResume", "Fragment.java", 3135, false),
            ),
            toolCallInfo = null,
            affectedTests = mapOf("testHomeLoad" to 5, "testProfileEdit" to 3),
            recentCaptures = listOf(
                FailureCapture("cap-4", CaptureType.Video, "/captures/anr-1/1.mp4", now - 7200000, "Pixel 7"),
                FailureCapture("cap-5", CaptureType.Video, "/captures/anr-1/2.mp4", now - 14400000, "Pixel 6"),
            ),
            sampleOccurrences = listOf(
                FailureOccurrence("occ-7", now - 7200000, "Pixel 7", "Android 14", "2.4.1-debug", "session-7", "Home", listOf("Splash", "Login", "Home"), "testHomeLoad", "/captures/anr-1/1.mp4", CaptureType.Video),
                FailureOccurrence("occ-8", now - 14400000, "Pixel 6", "Android 13", "2.4.1-debug", "session-8", "Home", listOf("Splash", "Login", "Home"), "testProfileEdit", "/captures/anr-1/2.mp4", CaptureType.Video),
                FailureOccurrence("occ-9", now - 21600000, "Samsung A54", "Android 13", "2.4.0", "session-9", "Home", listOf("Splash", "Login", "Home"), "testHomeLoad", null, null),
            ),
        ),

        // Tool call failure with aggregated duration stats and parameter variants
        FailureGroup(
            id = "tool-1",
            type = FailureType.ToolCallFailure,
            signature = "tapOn failed: Element not found",
            title = "tapOn: Element not found",
            message = "Element with text not found within timeout. Check element visibility and timing.",
            firstOccurrence = now - 86400000,
            lastOccurrence = now - 1800000,
            totalCount = 12,
            uniqueSessions = 10,
            severity = FailureSeverity.Medium,
            deviceBreakdown = listOf(
                DeviceBreakdown("iPhone 15 Pro", "iOS 17.2", 5, 42f),
                DeviceBreakdown("iPhone 14", "iOS 17.1", 4, 33f),
                DeviceBreakdown("Pixel 8", "Android 15", 3, 25f),
            ),
            versionBreakdown = listOf(
                VersionBreakdown("2.4.0", 8, 67f),
                VersionBreakdown("2.4.1-debug", 4, 33f),
            ),
            screenBreakdown = listOf(
                ScreenBreakdown("Home", 12, 0, 100f),
                ScreenBreakdown("Cart", 12, 0, 100f),
                ScreenBreakdown("Checkout", 12, 12, 100f),
            ),
            failureScreens = mapOf("Checkout" to 12),
            stackTraceElements = emptyList(),
            toolCallInfo = AggregatedToolCallInfo(
                toolName = "tapOn",
                errorCodes = mapOf("ELEMENT_NOT_FOUND" to 10, "TIMEOUT" to 2),
                parameterVariants = mapOf(
                    "text" to listOf("Submit", "Complete Order", "Place Order"),
                    "timeout" to listOf("5000", "10000"),
                ),
                durationStats = DurationStats(
                    minMs = 5001,
                    maxMs = 10234,
                    avgMs = 6543,
                    medianMs = 5500,
                    p95Ms = 9800,
                ),
            ),
            affectedTests = mapOf("testFormSubmission" to 7, "testCheckout" to 5),
            recentCaptures = listOf(
                FailureCapture("cap-6", CaptureType.Screenshot, "/captures/tool-1/1.png", now - 1800000, "iPhone 15 Pro"),
                FailureCapture("cap-7", CaptureType.Screenshot, "/captures/tool-1/2.png", now - 3600000, "Pixel 8"),
                FailureCapture("cap-8", CaptureType.Screenshot, "/captures/tool-1/3.png", now - 7200000, "iPhone 14"),
            ),
            sampleOccurrences = listOf(
                FailureOccurrence("occ-10", now - 1800000, "iPhone 15 Pro", "iOS 17.2", "2.4.0", "session-10", "Checkout", listOf("Home", "Cart", "Checkout"), "testCheckout", "/captures/tool-1/1.png", CaptureType.Screenshot),
                FailureOccurrence("occ-11", now - 3600000, "Pixel 8", "Android 15", "2.4.1-debug", "session-11", "Checkout", listOf("Home", "Cart", "Checkout"), "testFormSubmission", "/captures/tool-1/2.png", CaptureType.Screenshot),
                FailureOccurrence("occ-12", now - 7200000, "iPhone 14", "iOS 17.1", "2.4.0", "session-12", "Checkout", listOf("Home", "Cart", "Checkout"), "testCheckout", "/captures/tool-1/3.png", CaptureType.Screenshot),
            ),
        ),

        // Low severity crash
        FailureGroup(
            id = "crash-2",
            type = FailureType.Crash,
            signature = "IndexOutOfBoundsException at RecyclerView",
            title = "IndexOutOfBoundsException in MessageList",
            message = "java.lang.IndexOutOfBoundsException: Inconsistency detected. Invalid view holder adapter position",
            firstOccurrence = now - 86400000 * 5,
            lastOccurrence = now - 86400000,
            totalCount = 5,
            uniqueSessions = 5,
            severity = FailureSeverity.Low,
            deviceBreakdown = listOf(
                DeviceBreakdown("Pixel 8", "Android 15", 3, 60f),
                DeviceBreakdown("Pixel 7", "Android 14", 2, 40f),
            ),
            versionBreakdown = listOf(
                VersionBreakdown("2.4.1-debug", 5, 100f),
            ),
            screenBreakdown = listOf(
                ScreenBreakdown("Home", 5, 0, 100f),
                ScreenBreakdown("Messages", 5, 5, 100f),
            ),
            failureScreens = mapOf("Messages" to 5),
            stackTraceElements = listOf(
                StackTraceElement("androidx.recyclerview.widget.RecyclerView", "findViewHolderForPosition", "RecyclerView.java", 1345, false),
                StackTraceElement("com.example.app.MessageListAdapter", "onBindViewHolder", "MessageListAdapter.kt", 67, true),
            ),
            toolCallInfo = null,
            affectedTests = mapOf("testSendMessage" to 5),
            recentCaptures = emptyList(),
            sampleOccurrences = listOf(
                FailureOccurrence("occ-13", now - 86400000, "Pixel 8", "Android 15", "2.4.1-debug", "session-13", "Messages", listOf("Home", "Messages"), "testSendMessage", null, null),
                FailureOccurrence("occ-14", now - 86400000 * 2, "Pixel 7", "Android 14", "2.4.1-debug", "session-14", "Messages", listOf("Home", "Messages"), "testSendMessage", null, null),
            ),
        ),
    )
}
