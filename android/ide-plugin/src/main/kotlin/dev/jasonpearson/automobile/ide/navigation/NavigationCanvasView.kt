@file:OptIn(ExperimentalFoundationApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.ide.navigation

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.onPointerEvent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.jetbrains.jewel.foundation.theme.JewelTheme
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.component.Tooltip
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt

// Layout constants
private val NODE_WIDTH = 80.dp
private val NODE_HEIGHT = 140.dp
private val HORIZONTAL_SPACING = 160.dp
private val VERTICAL_SPACING = 180.dp

// Computed node positions based on a simple layered layout
private data class NodePosition(
    val screenId: String,
    val x: Float,
    val y: Float,
)

// Edge connection tracking key
private data class EdgeKey(val screen: String, val edge: String)

@Composable
fun NavigationCanvasView(
    screens: List<ScreenNode>,
    transitions: List<ScreenTransition>,
    onScreenSelected: (String) -> Unit,
) {
    val density = LocalDensity.current
    val colors = JewelTheme.globalColors

    // Zoom and pan state
    // TODO: Smooth zoom animation was janky, using direct state for now
    // var targetScale by remember { mutableFloatStateOf(1f) }
    // val scale by animateFloatAsState(
    //     targetValue = targetScale,
    //     animationSpec = tween(durationMillis = 150),
    //     label = "zoom"
    // )
    var scale by remember { mutableFloatStateOf(1f) }
    var offsetX by remember { mutableFloatStateOf(0f) }
    var offsetY by remember { mutableFloatStateOf(0f) }

    // Compute node positions using simple layered layout
    val nodePositions = remember(screens, transitions) {
        computeNodePositions(screens, transitions, density)
    }

    // Create lookup maps
    val screenById = remember(screens) { screens.associateBy { it.id } }
    val screenByName = remember(screens) { screens.associateBy { it.name } }
    val positionByName = remember(nodePositions) { nodePositions.associateBy { it.screenId } }

    // Convert dp to px for drawing
    val nodeWidthPx = with(density) { NODE_WIDTH.toPx() }
    val nodeHeightPx = with(density) { NODE_HEIGHT.toPx() }
    val arrowColor = colors.text.normal.copy(alpha = 0.3f)

    BoxWithConstraints(
        modifier = Modifier.fillMaxSize()
    ) {
        val viewportWidth = constraints.maxWidth.toFloat()
        val viewportHeight = constraints.maxHeight.toFloat()

        // Zoom helper that keeps a specific point fixed
        fun zoomAroundPoint(newScale: Float, pivotX: Float, pivotY: Float) {
            val oldScale = scale
            // Find the content point at the pivot
            val contentX = (pivotX - offsetX) / oldScale
            val contentY = (pivotY - offsetY) / oldScale
            // Update scale
            scale = newScale
            // Adjust offset so the same content point stays at pivot
            offsetX = pivotX - contentX * newScale
            offsetY = pivotY - contentY * newScale
        }

        // Zoom helper that keeps viewport center fixed
        fun zoomAroundCenter(newScale: Float) {
            zoomAroundPoint(newScale, viewportWidth / 2, viewportHeight / 2)
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(Unit) {
                    detectDragGestures { change, dragAmount ->
                        change.consume()
                        offsetX += dragAmount.x
                        offsetY += dragAmount.y
                    }
                }
                .onPointerEvent(PointerEventType.Scroll) { event ->
                    val change = event.changes.firstOrNull() ?: return@onPointerEvent
                    val scrollDelta = change.scrollDelta.y
                    if (scrollDelta != 0f) {
                        // 10x less sensitive: smaller zoom factor per scroll tick
                        val zoomFactor = if (scrollDelta > 0) 0.99f else 1.01f
                        val newScale = (scale * zoomFactor).coerceIn(0.3f, 3f)
                        // Zoom around cursor position
                        zoomAroundPoint(newScale, change.position.x, change.position.y)
                    }
                }
                .drawBehind {
                // Draw connection lines on the canvas with orthogonal routing and rounded corners
                val strokeWidth = 3f * scale
                val cornerRadius = 12f * scale
                val connectionSpacing = 8f * scale

                // First pass: count connections per node edge to calculate offsets
                val outgoingEdges = mutableMapOf<EdgeKey, MutableList<String>>()
                val incomingEdges = mutableMapOf<EdgeKey, MutableList<String>>()

                transitions.forEach { transition ->
                    val fromPos = positionByName[transition.fromScreen]
                    val toPos = positionByName[transition.toScreen]

                    if (fromPos != null && toPos != null) {
                        val goingRight = (toPos.x) > (fromPos.x + nodeWidthPx)
                        val goingLeft = (toPos.x + nodeWidthPx) < fromPos.x

                        if (goingRight) {
                            outgoingEdges.getOrPut(EdgeKey(transition.fromScreen, "right")) { mutableListOf() }.add(transition.id)
                            incomingEdges.getOrPut(EdgeKey(transition.toScreen, "left")) { mutableListOf() }.add(transition.id)
                        } else if (goingLeft) {
                            outgoingEdges.getOrPut(EdgeKey(transition.fromScreen, "left")) { mutableListOf() }.add(transition.id)
                            incomingEdges.getOrPut(EdgeKey(transition.toScreen, "right")) { mutableListOf() }.add(transition.id)
                        } else {
                            val fromCenterY = fromPos.y + nodeHeightPx / 2
                            val toCenterY = toPos.y + nodeHeightPx / 2
                            if (toCenterY > fromCenterY) {
                                outgoingEdges.getOrPut(EdgeKey(transition.fromScreen, "bottom")) { mutableListOf() }.add(transition.id)
                                incomingEdges.getOrPut(EdgeKey(transition.toScreen, "top")) { mutableListOf() }.add(transition.id)
                            } else {
                                outgoingEdges.getOrPut(EdgeKey(transition.fromScreen, "top")) { mutableListOf() }.add(transition.id)
                                incomingEdges.getOrPut(EdgeKey(transition.toScreen, "bottom")) { mutableListOf() }.add(transition.id)
                            }
                        }
                    }
                }

                // Helper to calculate offset from center for a connection
                fun getEdgeOffset(edgeConnections: List<String>, transitionId: String): Float {
                    val index = edgeConnections.indexOf(transitionId)
                    if (index == -1 || edgeConnections.size == 1) return 0f
                    // First at center (index 0 -> offset 0)
                    // Second at +spacing, third at -spacing, fourth at +2*spacing, etc.
                    return when (index) {
                        0 -> 0f
                        else -> {
                            val slot = (index + 1) / 2
                            val sign = if (index % 2 == 1) 1 else -1
                            slot * connectionSpacing * sign
                        }
                    }
                }

                // Second pass: draw transitions with proper offsets
                transitions.forEach { transition ->
                    val fromPos = positionByName[transition.fromScreen]
                    val toPos = positionByName[transition.toScreen]

                    if (fromPos != null && toPos != null) {
                        // Calculate scaled node positions
                        val fromLeft = fromPos.x * scale + offsetX
                        val fromRight = (fromPos.x + nodeWidthPx) * scale + offsetX
                        val fromCenterY = (fromPos.y + nodeHeightPx / 2) * scale + offsetY
                        val fromCenterX = (fromPos.x + nodeWidthPx / 2) * scale + offsetX
                        val fromTop = fromPos.y * scale + offsetY
                        val fromBottom = (fromPos.y + nodeHeightPx) * scale + offsetY

                        val toLeft = toPos.x * scale + offsetX
                        val toRight = (toPos.x + nodeWidthPx) * scale + offsetX
                        val toCenterY = (toPos.y + nodeHeightPx / 2) * scale + offsetY
                        val toCenterX = (toPos.x + nodeWidthPx / 2) * scale + offsetX
                        val toTop = toPos.y * scale + offsetY
                        val toBottom = (toPos.y + nodeHeightPx) * scale + offsetY

                        // Determine exit and entry edges
                        val goingRight = toLeft > fromRight
                        val goingLeft = toRight < fromLeft

                        val startX: Float
                        val startY: Float
                        val endX: Float
                        val endY: Float

                        if (goingRight) {
                            val fromEdge = outgoingEdges[EdgeKey(transition.fromScreen, "right")] ?: listOf()
                            val toEdge = incomingEdges[EdgeKey(transition.toScreen, "left")] ?: listOf()
                            val fromOffset = getEdgeOffset(fromEdge, transition.id)
                            val toOffset = getEdgeOffset(toEdge, transition.id)
                            startX = fromRight
                            startY = fromCenterY + fromOffset
                            endX = toLeft
                            endY = toCenterY + toOffset
                        } else if (goingLeft) {
                            val fromEdge = outgoingEdges[EdgeKey(transition.fromScreen, "left")] ?: listOf()
                            val toEdge = incomingEdges[EdgeKey(transition.toScreen, "right")] ?: listOf()
                            val fromOffset = getEdgeOffset(fromEdge, transition.id)
                            val toOffset = getEdgeOffset(toEdge, transition.id)
                            startX = fromLeft
                            startY = fromCenterY + fromOffset
                            endX = toRight
                            endY = toCenterY + toOffset
                        } else if (toCenterY > fromCenterY) {
                            val fromEdge = outgoingEdges[EdgeKey(transition.fromScreen, "bottom")] ?: listOf()
                            val toEdge = incomingEdges[EdgeKey(transition.toScreen, "top")] ?: listOf()
                            val fromOffset = getEdgeOffset(fromEdge, transition.id)
                            val toOffset = getEdgeOffset(toEdge, transition.id)
                            startX = fromCenterX + fromOffset
                            startY = fromBottom
                            endX = toCenterX + toOffset
                            endY = toTop
                        } else {
                            val fromEdge = outgoingEdges[EdgeKey(transition.fromScreen, "top")] ?: listOf()
                            val toEdge = incomingEdges[EdgeKey(transition.toScreen, "bottom")] ?: listOf()
                            val fromOffset = getEdgeOffset(fromEdge, transition.id)
                            val toOffset = getEdgeOffset(toEdge, transition.id)
                            startX = fromCenterX + fromOffset
                            startY = fromTop
                            endX = toCenterX + toOffset
                            endY = toBottom
                        }

                        // Draw orthogonal path with rounded corners
                        val path = Path()
                        val midX = (startX + endX) / 2
                        val dy = endY - startY
                        val dx = endX - startX
                        val r = min(cornerRadius, min(abs(dx) / 2, abs(dy) / 2))

                        if (abs(dy) < 1f) {
                            // Straight horizontal line
                            path.moveTo(startX, startY)
                            path.lineTo(endX, endY)
                        } else if (goingRight || goingLeft) {
                            // Horizontal-vertical-horizontal routing
                            path.moveTo(startX, startY)

                            // First horizontal segment
                            if (dy > 0) {
                                // Going down
                                path.lineTo(midX - r, startY)
                                path.quadraticTo(midX, startY, midX, startY + r)
                                path.lineTo(midX, endY - r)
                                path.quadraticTo(midX, endY, midX + r * (if (goingRight) 1 else -1), endY)
                            } else {
                                // Going up
                                path.lineTo(midX - r * (if (goingRight) 1 else -1), startY)
                                path.quadraticTo(midX, startY, midX, startY - r)
                                path.lineTo(midX, endY + r)
                                path.quadraticTo(midX, endY, midX + r * (if (goingRight) 1 else -1), endY)
                            }

                            // Final horizontal segment to target
                            path.lineTo(endX, endY)
                        } else {
                            // Vertical-horizontal-vertical routing (for overlapping x)
                            val midY = (startY + endY) / 2
                            path.moveTo(startX, startY)

                            if (dx > 0) {
                                path.lineTo(startX, midY - r * (if (dy > 0) 1 else -1))
                                path.quadraticTo(startX, midY, startX + r, midY)
                                path.lineTo(endX - r, midY)
                                path.quadraticTo(endX, midY, endX, midY + r * (if (dy > 0) 1 else -1))
                            } else if (dx < 0) {
                                path.lineTo(startX, midY - r * (if (dy > 0) 1 else -1))
                                path.quadraticTo(startX, midY, startX - r, midY)
                                path.lineTo(endX + r, midY)
                                path.quadraticTo(endX, midY, endX, midY + r * (if (dy > 0) 1 else -1))
                            } else {
                                // Straight vertical line
                                path.lineTo(endX, endY)
                            }

                            path.lineTo(endX, endY)
                        }

                        drawPath(
                            path = path,
                            color = arrowColor,
                            style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
                        )
                    }
                }
                }
        ) {
            // Render screen nodes as Composables
            nodePositions.forEach { pos ->
                val screen = screenByName[pos.screenId] ?: return@forEach

                Box(
                    modifier = Modifier
                        .offset {
                            IntOffset(
                                (pos.x * scale + offsetX).roundToInt(),
                                (pos.y * scale + offsetY).roundToInt()
                            )
                        }
                        .graphicsLayer {
                            scaleX = scale
                            scaleY = scale
                            transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0f, 0f)
                        }
                ) {
                    ScreenNodeCard(
                        screen = screen,
                        onClick = { onScreenSelected(screen.id) },
                    )
                }
            }

            // Zoom controls in bottom right
            ZoomControls(
                scale = scale,
                onZoomIn = { zoomAroundCenter((scale * 1.2f).coerceAtMost(3f)) },
                onZoomOut = { zoomAroundCenter((scale / 1.2f).coerceAtLeast(0.3f)) },
                onReset = {
                    scale = 1f
                    offsetX = 0f
                    offsetY = 0f
                },
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(16.dp),
            )
        }
    }
}

@Composable
private fun ScreenNodeCard(
    screen: ScreenNode,
    onClick: () -> Unit,
) {
    val colors = JewelTheme.globalColors
    val coverageColor = when {
        screen.testCoverage >= 80 -> Color(0xFF4CAF50)
        screen.testCoverage >= 50 -> Color(0xFFFFC107)
        else -> Color(0xFFFF5722)
    }

    Tooltip(
        tooltip = {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(screen.name, fontSize = 12.sp)
                Text(screen.type, fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.7f))
                Text(screen.packageName, fontSize = 10.sp, color = colors.text.normal.copy(alpha = 0.5f))
                Text("Coverage: ${screen.testCoverage}%", fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.7f))
            }
        },
    ) {
        Column(
            modifier = Modifier
                .size(NODE_WIDTH, NODE_HEIGHT)
                .background(colors.text.normal.copy(alpha = 0.1f), RoundedCornerShape(8.dp))
                .clickable(onClick = onClick)
                .pointerHoverIcon(PointerIcon.Hand)
                .padding(6.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // Screen preview placeholder (portrait phone shape)
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxSize()
                    .padding(4.dp)
                    .background(colors.text.normal.copy(alpha = 0.08f), RoundedCornerShape(4.dp)),
                contentAlignment = Alignment.Center,
            ) {
                // Could show actual screenshot thumbnail here
            }

            // Screen name (truncated)
            Text(
                text = screen.name.take(12) + if (screen.name.length > 12) "…" else "",
                fontSize = 9.sp,
                color = colors.text.normal.copy(alpha = 0.8f),
                modifier = Modifier.padding(top = 4.dp),
            )

            // Coverage indicator
            Row(
                horizontalArrangement = Arrangement.spacedBy(3.dp),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(top = 2.dp),
            ) {
                Box(modifier = Modifier.size(6.dp).background(coverageColor, CircleShape))
                Text(
                    "${screen.testCoverage}%",
                    fontSize = 8.sp,
                    color = colors.text.normal.copy(alpha = 0.5f),
                )
            }
        }
    }
}

@Composable
private fun ZoomControls(
    scale: Float,
    onZoomIn: () -> Unit,
    onZoomOut: () -> Unit,
    onReset: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = JewelTheme.globalColors

    Column(
        modifier = modifier
            .background(colors.text.normal.copy(alpha = 0.1f), RoundedCornerShape(8.dp))
            .padding(4.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        ZoomButton("+", onClick = onZoomIn)
        ZoomButton("−", onClick = onZoomOut)
        ZoomButton("⟲", onClick = onReset)

        Text(
            "${(scale * 100).toInt()}%",
            fontSize = 9.sp,
            color = colors.text.normal.copy(alpha = 0.5f),
            modifier = Modifier.align(Alignment.CenterHorizontally).padding(top = 2.dp),
        )
    }
}

@Composable
private fun ZoomButton(label: String, onClick: () -> Unit) {
    val colors = JewelTheme.globalColors

    Box(
        modifier = Modifier
            .size(28.dp)
            .background(colors.text.normal.copy(alpha = 0.1f), RoundedCornerShape(4.dp))
            .clickable(onClick = onClick)
            .pointerHoverIcon(PointerIcon.Hand),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, fontSize = 14.sp)
    }
}

/**
 * Simple layered layout algorithm.
 * Places nodes in layers based on their depth from entry points.
 */
private fun computeNodePositions(
    screens: List<ScreenNode>,
    transitions: List<ScreenTransition>,
    density: androidx.compose.ui.unit.Density,
): List<NodePosition> {
    val horizontalSpacingPx = with(density) { HORIZONTAL_SPACING.toPx() }
    val verticalSpacingPx = with(density) { VERTICAL_SPACING.toPx() }

    // Build adjacency map (by screen name since transitions use names)
    val outgoing = transitions.groupBy { it.fromScreen }
    val incoming = transitions.groupBy { it.toScreen }

    // Find entry points (screens with no incoming transitions, or fewer incoming than outgoing)
    val screenNames = screens.map { it.name }.toSet()
    val entryPoints = screens.filter { screen ->
        val inCount = incoming[screen.name]?.size ?: 0
        val outCount = outgoing[screen.name]?.size ?: 0
        inCount == 0 || (screen.type == "Activity" && outCount > inCount)
    }.map { it.name }.ifEmpty { screens.firstOrNull()?.name?.let { listOf(it) } ?: emptyList() }

    // BFS to assign layers
    val layers = mutableMapOf<String, Int>()
    val queue = ArrayDeque<String>()

    entryPoints.forEach {
        layers[it] = 0
        queue.add(it)
    }

    while (queue.isNotEmpty()) {
        val current = queue.removeFirst()
        val currentLayer = layers[current] ?: 0

        outgoing[current]?.forEach { transition ->
            if (transition.toScreen in screenNames && transition.toScreen !in layers) {
                layers[transition.toScreen] = currentLayer + 1
                queue.add(transition.toScreen)
            }
        }
    }

    // Assign any unvisited screens to layer 0
    screens.forEach { screen ->
        if (screen.name !in layers) {
            layers[screen.name] = 0
        }
    }

    // Group by layer and compute positions
    val layerGroups = screens.groupBy { layers[it.name] ?: 0 }
    val positions = mutableListOf<NodePosition>()

    layerGroups.forEach { (layer, screensInLayer) ->
        screensInLayer.forEachIndexed { index, screen ->
            positions.add(
                NodePosition(
                    screenId = screen.name,
                    x = layer * horizontalSpacingPx + 20f,
                    y = index * verticalSpacingPx + 20f,
                )
            )
        }
    }

    return positions
}
