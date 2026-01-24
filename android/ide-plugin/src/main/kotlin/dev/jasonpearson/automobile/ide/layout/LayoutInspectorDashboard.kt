package dev.jasonpearson.automobile.ide.layout

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.jetbrains.jewel.foundation.theme.JewelTheme
import org.jetbrains.jewel.ui.component.Text

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

    // Main content with 3 panels
    Row(modifier = modifier.fillMaxSize()) {
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
