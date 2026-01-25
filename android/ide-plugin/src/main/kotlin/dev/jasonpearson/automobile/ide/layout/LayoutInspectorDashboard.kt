package dev.jasonpearson.automobile.ide.layout

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.jetbrains.jewel.foundation.theme.JewelTheme
import org.jetbrains.jewel.ui.component.Text
import dev.jasonpearson.automobile.ide.daemon.AutoMobileClient
import dev.jasonpearson.automobile.ide.datasource.DataSourceMode

/**
 * Main Layout Inspector dashboard with 3-panel layout:
 * - Left: Device screen with screenshot and overlays (expands when panels collapse)
 * - Center: View hierarchy tree (collapsible)
 * - Right: Property inspector (collapsible)
 */
@Composable
fun LayoutInspectorDashboard(
    modifier: Modifier = Modifier,
    dataSourceMode: DataSourceMode = DataSourceMode.Fake,
    clientProvider: (() -> AutoMobileClient)? = null,  // MCP client for real data
) {
    val state = rememberLayoutInspectorState()
    val colors = JewelTheme.globalColors

    // Fetch view hierarchy from data source
    LaunchedEffect(dataSourceMode, clientProvider) {
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            try {
                val dataSource = dev.jasonpearson.automobile.ide.datasource.DataSourceFactory.createLayoutDataSource(dataSourceMode, clientProvider)
                when (val result = dataSource.getViewHierarchy()) {
                    is dev.jasonpearson.automobile.ide.datasource.Result.Success -> {
                        state.updateHierarchy(result.data)
                    }
                    is dev.jasonpearson.automobile.ide.datasource.Result.Error -> {
                        // Keep current hierarchy or show error
                    }
                    is dev.jasonpearson.automobile.ide.datasource.Result.Loading -> {
                        // Keep loading state
                    }
                }
            } catch (e: Exception) {
                // Keep current hierarchy or show error
            }
        }
    }

    // Panel collapse states - default to collapsed, remember user preference
    // TODO: Persist these to IDE preferences for remembering across sessions
    var isHierarchyCollapsed by remember { mutableStateOf(true) }
    var isPropertiesCollapsed by remember { mutableStateOf(true) }

    // Main content with 3 panels
    Row(modifier = modifier.fillMaxSize()) {
        // Left panel: Device Screen (flexible - expands when others collapse)
        Box(
            modifier = Modifier
                .weight(1f)
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

        // Center panel: View Hierarchy (collapsible)
        CollapsiblePanel(
            title = "Hierarchy",
            isCollapsed = isHierarchyCollapsed,
            onToggle = { isHierarchyCollapsed = !isHierarchyCollapsed },
            expandedWidth = 250.dp,
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                PanelHeader(
                    title = "View Hierarchy",
                    onCollapse = { isHierarchyCollapsed = true },
                )
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

        // Vertical divider (only when hierarchy is expanded)
        if (!isHierarchyCollapsed) {
            VerticalDivider()
        }

        // Right panel: Properties (collapsible)
        CollapsiblePanel(
            title = "Properties",
            isCollapsed = isPropertiesCollapsed,
            onToggle = { isPropertiesCollapsed = !isPropertiesCollapsed },
            expandedWidth = 200.dp,
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                PanelHeader(
                    title = "Properties",
                    onCollapse = { isPropertiesCollapsed = true },
                )
                PropertyInspectorPanel(
                    element = state.selectedElement,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }
}

@Composable
private fun CollapsiblePanel(
    title: String,
    isCollapsed: Boolean,
    onToggle: () -> Unit,
    expandedWidth: androidx.compose.ui.unit.Dp,
    content: @Composable () -> Unit,
) {
    val colors = JewelTheme.globalColors

    if (isCollapsed) {
        // Collapsed state: vertical tab aligned to top
        Box(
            modifier = Modifier
                .width(24.dp)
                .fillMaxHeight()
                .background(colors.text.normal.copy(alpha = 0.03f))
                .clickable(onClick = onToggle)
                .pointerHoverIcon(PointerIcon.Hand),
        ) {
            // Rotated text positioned at top - use a box with height to contain rotated text
            Box(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 12.dp)
                    .width(24.dp)
                    .height(100.dp),
                contentAlignment = Alignment.TopCenter,
            ) {
                Text(
                    title,
                    fontSize = 11.sp,
                    maxLines = 1,
                    softWrap = false,
                    color = colors.text.normal.copy(alpha = 0.6f),
                    modifier = Modifier.rotate(-90f),
                )
            }
        }
    } else {
        // Expanded state: full panel
        Box(
            modifier = Modifier
                .width(expandedWidth)
                .fillMaxHeight(),
        ) {
            content()
        }
    }
}

@Composable
private fun PanelHeader(
    title: String,
    onCollapse: (() -> Unit)? = null,
) {
    val colors = JewelTheme.globalColors

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.text.normal.copy(alpha = 0.03f))
            .padding(horizontal = 8.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            title,
            fontSize = 11.sp,
            color = colors.text.normal.copy(alpha = 0.7f),
        )

        if (onCollapse != null) {
            Text(
                "«",
                fontSize = 12.sp,
                color = colors.text.normal.copy(alpha = 0.4f),
                modifier = Modifier
                    .clickable(onClick = onCollapse)
                    .pointerHoverIcon(PointerIcon.Hand)
                    .padding(horizontal = 4.dp),
            )
        }
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
