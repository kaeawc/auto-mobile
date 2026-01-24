@file:OptIn(
    androidx.compose.ui.ExperimentalComposeUiApi::class,
    androidx.compose.foundation.ExperimentalFoundationApi::class,
    org.jetbrains.jewel.foundation.ExperimentalJewelApi::class,
)

package dev.jasonpearson.automobile.ide.layout

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.jetbrains.jewel.foundation.theme.JewelTheme
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.component.Tooltip

/**
 * Main Layout Inspector dashboard with 3-panel layout:
 * - Left (50%): Device screen with screenshot and overlays
 * - Center (30%): View hierarchy tree
 * - Right (20%): Property inspector
 */
@Composable
fun LayoutInspectorDashboard(
    modifier: Modifier = Modifier,
) {
    val state = rememberLayoutInspectorState()
    val colors = JewelTheme.globalColors

    Column(modifier = modifier.fillMaxSize()) {
        // Toolbar
        InspectorToolbar(
            connectionStatus = state.connectionStatus,
            streamingMode = state.streamingMode,
            onLiveToggle = {
                if (state.streamingMode == StreamingMode.Live) {
                    state.stopScreenshotStream()
                } else {
                    state.startScreenshotStream()
                }
            },
            onRefresh = { state.refreshHierarchy() },
        )

        // Main content with 3 panels
        Row(
            modifier = Modifier.fillMaxSize(),
        ) {
            // Left panel: Device Screen (50%)
            Box(
                modifier = Modifier
                    .weight(0.5f)
                    .fillMaxHeight()
                    .background(colors.text.normal.copy(alpha = 0.02f)),
            ) {
                DeviceScreenView(
                    screenshotData = state.screenshotData,
                    screenWidth = state.screenWidth,
                    screenHeight = state.screenHeight,
                    hierarchy = state.hierarchy,
                    selectedElementId = state.selectedElementId,
                    hoveredElementId = state.hoveredElementId,
                    onElementSelected = { state.selectElement(it) },
                    onElementHovered = { state.hoverElement(it) },
                    modifier = Modifier.fillMaxSize(),
                )
            }

            // Vertical divider
            VerticalDivider()

            // Center panel: View Hierarchy (30%)
            Box(
                modifier = Modifier
                    .weight(0.3f)
                    .fillMaxHeight(),
            ) {
                Column(modifier = Modifier.fillMaxSize()) {
                    PanelHeader(title = "View Hierarchy")
                    HierarchyTreeView(
                        hierarchy = state.hierarchy,
                        selectedElementId = state.selectedElementId,
                        hoveredElementId = state.hoveredElementId,
                        onElementSelected = { state.selectElement(it) },
                        onElementHovered = { state.hoverElement(it) },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }

            // Vertical divider
            VerticalDivider()

            // Right panel: Properties (20%)
            Box(
                modifier = Modifier
                    .weight(0.2f)
                    .fillMaxHeight(),
            ) {
                Column(modifier = Modifier.fillMaxSize()) {
                    PanelHeader(title = "Properties")
                    PropertyInspectorPanel(
                        element = state.selectedElement,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
        }
    }
}

@Composable
private fun InspectorToolbar(
    connectionStatus: ConnectionStatus,
    streamingMode: StreamingMode,
    onLiveToggle: () -> Unit,
    onRefresh: () -> Unit,
) {
    val colors = JewelTheme.globalColors
    val isLive = streamingMode == StreamingMode.Live
    val isConnected = connectionStatus == ConnectionStatus.Connected

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.text.normal.copy(alpha = 0.03f))
            .padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Left side: Live toggle and status
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Live indicator and toggle
            Tooltip(tooltip = { Text(if (isLive) "Pause live updates" else "Start live updates") }) {
                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(
                            if (isLive) Color(0xFF4CAF50).copy(alpha = 0.15f)
                            else colors.text.normal.copy(alpha = 0.05f)
                        )
                        .clickable(enabled = isConnected, onClick = onLiveToggle)
                        .pointerHoverIcon(if (isConnected) PointerIcon.Hand else PointerIcon.Default)
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // Live dot
                    Box(
                        modifier = Modifier
                            .size(8.dp)
                            .background(
                                if (isLive) Color(0xFF4CAF50) else colors.text.normal.copy(alpha = 0.3f),
                                CircleShape
                            )
                    )
                    Text(
                        if (isLive) "Live" else "Paused",
                        fontSize = 11.sp,
                        color = if (isLive) Color(0xFF4CAF50) else colors.text.normal.copy(alpha = 0.6f),
                    )
                }
            }

            // Connection status
            ConnectionStatusIndicator(status = connectionStatus)

            // Refresh button
            Tooltip(tooltip = { Text("Refresh hierarchy") }) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(colors.text.normal.copy(alpha = 0.05f))
                        .clickable(enabled = isConnected, onClick = onRefresh)
                        .pointerHoverIcon(if (isConnected) PointerIcon.Hand else PointerIcon.Default)
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                ) {
                    Text(
                        "\u21BB", // Refresh icon
                        fontSize = 12.sp,
                        color = colors.text.normal.copy(alpha = if (isConnected) 0.7f else 0.3f),
                    )
                }
            }
        }

        // Right side: Placeholder for future controls (3D view, filter, etc.)
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Future: Filter button
            // Future: 3D view toggle
        }
    }
}

@Composable
private fun ConnectionStatusIndicator(status: ConnectionStatus) {
    val colors = JewelTheme.globalColors

    val (icon, color, label) = when (status) {
        ConnectionStatus.Disconnected -> Triple("\u26AA", colors.text.normal.copy(alpha = 0.4f), "Disconnected")
        ConnectionStatus.Connecting -> Triple("\u23F3", Color(0xFFFFC107), "Connecting...")
        ConnectionStatus.Connected -> Triple("\u2713", Color(0xFF4CAF50), "Connected")
        ConnectionStatus.Error -> Triple("\u26A0", Color(0xFFFF5722), "Error")
    }

    Tooltip(tooltip = { Text(label) }) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(icon, fontSize = 10.sp, color = color)
            Text(
                label,
                fontSize = 10.sp,
                color = color,
            )
        }
    }
}

@Composable
private fun PanelHeader(title: String) {
    val colors = JewelTheme.globalColors

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.text.normal.copy(alpha = 0.03f))
            .padding(horizontal = 8.dp, vertical = 6.dp),
    ) {
        Text(
            title,
            fontSize = 11.sp,
            color = colors.text.normal.copy(alpha = 0.7f),
        )
    }
}

@Composable
private fun VerticalDivider() {
    val colors = JewelTheme.globalColors

    Box(
        modifier = Modifier
            .width(1.dp)
            .fillMaxHeight()
            .background(colors.text.normal.copy(alpha = 0.1f))
    )
}
