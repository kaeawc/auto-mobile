package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/**
 * Shows a side-by-side diff of two network events' request/response bodies.
 * Added lines are highlighted green, removed lines red.
 */
@Composable
fun NetworkDiffView(
    left: TelemetryDisplayEvent.Network,
    right: TelemetryDisplayEvent.Network,
    modifier: Modifier = Modifier,
) {
    val colors = SharedTheme.globalColors
    val textColor = colors.text.normal

    Column(modifier = modifier.fillMaxSize().padding(8.dp)) {
        // Header
        Text(
            "Network Diff",
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            color = textColor,
        )
        Spacer(Modifier.height(8.dp))

        // Request body diff
        Text("Request Body", fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = textColor.copy(alpha = 0.7f))
        Spacer(Modifier.height(4.dp))
        DiffPanel(
            leftText = left.requestBody ?: "(empty)",
            rightText = right.requestBody ?: "(empty)",
            leftLabel = "${left.method} ${left.url}",
            rightLabel = "${right.method} ${right.url}",
            textColor = textColor,
            modifier = Modifier.weight(1f).fillMaxWidth(),
        )

        Spacer(Modifier.height(12.dp))

        // Response body diff
        Text("Response Body", fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = textColor.copy(alpha = 0.7f))
        Spacer(Modifier.height(4.dp))
        DiffPanel(
            leftText = left.responseBody ?: "(empty)",
            rightText = right.responseBody ?: "(empty)",
            leftLabel = "Status ${left.statusCode}",
            rightLabel = "Status ${right.statusCode}",
            textColor = textColor,
            modifier = Modifier.weight(1f).fillMaxWidth(),
        )
    }
}

@Composable
private fun DiffPanel(
    leftText: String,
    rightText: String,
    leftLabel: String,
    rightLabel: String,
    textColor: Color,
    modifier: Modifier = Modifier,
) {
    val diffLines = remember(leftText, rightText) {
        computeLineDiff(leftText.lines(), rightText.lines())
    }

    Row(modifier = modifier, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        DiffSideColumn(diffLines, leftLabel, textColor, isLeftSide = true, modifier = Modifier.weight(1f))
        DiffSideColumn(diffLines, rightLabel, textColor, isLeftSide = false, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun DiffSideColumn(
    diffLines: List<DiffLine>,
    label: String,
    textColor: Color,
    isLeftSide: Boolean,
    modifier: Modifier = Modifier,
) {
    val skipType = if (isLeftSide) DiffLineType.Added else DiffLineType.Removed
    val highlightType = if (isLeftSide) DiffLineType.Removed else DiffLineType.Added
    val highlightColor = if (isLeftSide) Color(0xFFFF6B6B) else Color(0xFF51CF66)
    val prefix = if (isLeftSide) "-" else "+"

    Column(modifier = modifier) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(textColor.copy(alpha = 0.05f), RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp))
                .padding(horizontal = 6.dp, vertical = 3.dp),
        ) {
            Text(label, fontSize = 9.sp, color = textColor.copy(alpha = 0.5f), maxLines = 1)
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .background(textColor.copy(alpha = 0.02f), RoundedCornerShape(bottomStart = 4.dp, bottomEnd = 4.dp))
                .verticalScroll(rememberScrollState())
                .padding(4.dp),
        ) {
            diffLines.forEach { line ->
                if (line.type == skipType) return@forEach
                val isHighlight = line.type == highlightType
                val lineContent = if (isLeftSide) (line.leftLine ?: "") else (line.rightLine ?: "")
                val lineText = if (isHighlight) "$prefix $lineContent" else "  $lineContent"
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(if (isHighlight) highlightColor.copy(alpha = 0.15f) else Color.Transparent)
                        .padding(horizontal = 2.dp),
                ) {
                    Text(
                        lineText,
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace,
                        color = if (isHighlight) highlightColor else textColor.copy(alpha = 0.8f),
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

internal enum class DiffLineType { Same, Added, Removed }

internal data class DiffLine(
    val type: DiffLineType,
    val leftLine: String? = null,
    val rightLine: String? = null,
)

/**
 * Simple line-by-line diff using longest common subsequence (LCS).
 */
internal fun computeLineDiff(leftLines: List<String>, rightLines: List<String>): List<DiffLine> {
    val m = leftLines.size
    val n = rightLines.size

    // Build LCS table
    val dp = Array(m + 1) { IntArray(n + 1) }
    for (i in 1..m) {
        for (j in 1..n) {
            dp[i][j] = if (leftLines[i - 1] == rightLines[j - 1]) {
                dp[i - 1][j - 1] + 1
            } else {
                maxOf(dp[i - 1][j], dp[i][j - 1])
            }
        }
    }

    // Backtrack to produce diff
    val result = mutableListOf<DiffLine>()
    var i = m
    var j = n
    while (i > 0 || j > 0) {
        when {
            i > 0 && j > 0 && leftLines[i - 1] == rightLines[j - 1] -> {
                result.add(DiffLine(DiffLineType.Same, leftLines[i - 1], rightLines[j - 1]))
                i--; j--
            }
            j > 0 && (i == 0 || dp[i][j - 1] >= dp[i - 1][j]) -> {
                result.add(DiffLine(DiffLineType.Added, rightLine = rightLines[j - 1]))
                j--
            }
            else -> {
                result.add(DiffLine(DiffLineType.Removed, leftLine = leftLines[i - 1]))
                i--
            }
        }
    }
    return result.reversed()
}
