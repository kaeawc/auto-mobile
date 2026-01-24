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
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
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
    var scale by remember { mutableFloatStateOf(1f) }
    var offsetX by remember { mutableFloatStateOf(0f) }
    var offsetY by remember { mutableFloatStateOf(0f) }

    // Compute node positions using D3-style force-directed layout
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
                        val newScale = (scale * zoomFactor).coerceIn(0.05f, 3f)
                        // Zoom around cursor position
                        zoomAroundPoint(newScale, change.position.x, change.position.y)
                    }
                }
                .drawBehind {
                // Draw connection lines on the canvas with orthogonal routing and rounded corners
                val strokeWidth = 3f * scale
                val cornerRadius = 12f * scale
                val connectionSpacing = 8f * scale

                // Filter out back press transitions
                val forwardTransitions = transitions.filter { it.trigger != "back" }

                // First pass: count connections per node edge to calculate offsets
                // Rule: exit from right/top, enter from left/bottom
                val outgoingEdges = mutableMapOf<EdgeKey, MutableList<String>>()
                val incomingEdges = mutableMapOf<EdgeKey, MutableList<String>>()

                forwardTransitions.forEach { transition ->
                    val fromPos = positionByName[transition.fromScreen]
                    val toPos = positionByName[transition.toScreen]

                    if (fromPos != null && toPos != null) {
                        // Target entry point (left side center)
                        val targetX = toPos.x
                        val targetY = toPos.y + nodeHeightPx / 2

                        // Calculate distances from each exit side to target entry
                        val fromCenterX = fromPos.x + nodeWidthPx / 2
                        val fromCenterY = fromPos.y + nodeHeightPx / 2
                        val rightX = fromPos.x + nodeWidthPx
                        val topY = fromPos.y
                        val bottomY = fromPos.y + nodeHeightPx

                        // Distance from right side to target
                        val rightDist = kotlin.math.sqrt((targetX - rightX) * (targetX - rightX) + (targetY - fromCenterY) * (targetY - fromCenterY))
                        // Distance from top side to target
                        val topDist = kotlin.math.sqrt((targetX - fromCenterX) * (targetX - fromCenterX) + (targetY - topY) * (targetY - topY))
                        // Distance from bottom side to target
                        val bottomDist = kotlin.math.sqrt((targetX - fromCenterX) * (targetX - fromCenterX) + (targetY - bottomY) * (targetY - bottomY))

                        // Pick the closest exit side (right, top, or bottom)
                        val exitSide = when {
                            rightDist <= topDist && rightDist <= bottomDist -> "right"
                            topDist <= bottomDist -> "top"
                            else -> "bottom"
                        }

                        outgoingEdges.getOrPut(EdgeKey(transition.fromScreen, exitSide)) { mutableListOf() }.add(transition.id)
                        incomingEdges.getOrPut(EdgeKey(transition.toScreen, "left")) { mutableListOf() }.add(transition.id)
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

                // Second pass: draw forward transitions with proper offsets
                forwardTransitions.forEach { transition ->
                    val fromPos = positionByName[transition.fromScreen]
                    val toPos = positionByName[transition.toScreen]

                    if (fromPos != null && toPos != null) {
                        // Calculate scaled node positions
                        val fromRight = (fromPos.x + nodeWidthPx) * scale + offsetX
                        val fromCenterY = (fromPos.y + nodeHeightPx / 2) * scale + offsetY
                        val fromCenterX = (fromPos.x + nodeWidthPx / 2) * scale + offsetX
                        val fromTop = fromPos.y * scale + offsetY
                        val fromBottom = (fromPos.y + nodeHeightPx) * scale + offsetY

                        val toLeft = toPos.x * scale + offsetX
                        val toCenterY = (toPos.y + nodeHeightPx / 2) * scale + offsetY

                        // Determine which exit side was chosen
                        val exitSide = when {
                            outgoingEdges[EdgeKey(transition.fromScreen, "right")]?.contains(transition.id) == true -> "right"
                            outgoingEdges[EdgeKey(transition.fromScreen, "top")]?.contains(transition.id) == true -> "top"
                            else -> "bottom"
                        }

                        val toEdge = incomingEdges[EdgeKey(transition.toScreen, "left")] ?: listOf()
                        val toOffset = getEdgeOffset(toEdge, transition.id)
                        val endX = toLeft
                        val endY = toCenterY + toOffset

                        val startX: Float
                        val startY: Float

                        when (exitSide) {
                            "right" -> {
                                val fromEdge = outgoingEdges[EdgeKey(transition.fromScreen, "right")] ?: listOf()
                                val fromOffset = getEdgeOffset(fromEdge, transition.id)
                                startX = fromRight
                                startY = fromCenterY + fromOffset
                            }
                            "top" -> {
                                val fromEdge = outgoingEdges[EdgeKey(transition.fromScreen, "top")] ?: listOf()
                                val fromOffset = getEdgeOffset(fromEdge, transition.id)
                                startX = fromCenterX + fromOffset
                                startY = fromTop
                            }
                            else -> { // bottom
                                val fromEdge = outgoingEdges[EdgeKey(transition.fromScreen, "bottom")] ?: listOf()
                                val fromOffset = getEdgeOffset(fromEdge, transition.id)
                                startX = fromCenterX + fromOffset
                                startY = fromBottom
                            }
                        }

                        // Draw orthogonal path that avoids crossing source/target nodes
                        // Rule: edges MUST always approach entry point from the LEFT
                        val path = Path()
                        val r = cornerRadius
                        val padding = 30f * scale  // Clearance around nodes
                        val approachDistance = 40f * scale  // How far left of entry to start horizontal approach

                        // Source and target node bounds (scaled)
                        val srcTop = fromTop
                        val srcBottom = fromBottom
                        val tgtTop = toPos.y * scale + offsetY
                        val tgtBottom = (toPos.y + nodeHeightPx) * scale + offsetY

                        // The approach point is always to the LEFT of the entry point
                        val approachX = endX - approachDistance

                        path.moveTo(startX, startY)

                        when (exitSide) {
                            "right" -> {
                                if (endX > startX && approachX > startX) {
                                    // Target is to the right - route to approach point, then enter from left
                                    if (abs(endY - startY) < 1f) {
                                        // Same horizontal level - straight line to approach, then to entry
                                        path.lineTo(approachX, startY)
                                        path.lineTo(endX, endY)
                                    } else {
                                        // Different Y - need vertical segment
                                        // Route: start → midpoint → down/up → approach → entry
                                        val midX = (startX + approachX) / 2
                                        val bendR = min(r, min(abs(midX - startX), abs(endY - startY)) / 2)

                                        path.lineTo(midX - bendR, startY)
                                        if (endY > startY) {
                                            path.quadraticTo(midX, startY, midX, startY + bendR)
                                            path.lineTo(midX, endY - bendR)
                                            path.quadraticTo(midX, endY, midX + bendR, endY)
                                        } else {
                                            path.quadraticTo(midX, startY, midX, startY - bendR)
                                            path.lineTo(midX, endY + bendR)
                                            path.quadraticTo(midX, endY, midX + bendR, endY)
                                        }
                                        path.lineTo(endX, endY)
                                    }
                                } else {
                                    // Target is to the left - need to route around and still approach from left
                                    // Route: go right, then up/down, then all the way left past target, then right to entry
                                    val extendX = startX + padding
                                    val routeY = if (endY < srcTop) minOf(srcTop, tgtTop) - padding else maxOf(srcBottom, tgtBottom) + padding
                                    val bendR = min(r, padding / 2)

                                    // Go right first
                                    path.lineTo(extendX - bendR, startY)
                                    if (routeY < startY) {
                                        path.quadraticTo(extendX, startY, extendX, startY - bendR)
                                        path.lineTo(extendX, routeY + bendR)
                                        path.quadraticTo(extendX, routeY, extendX - bendR, routeY)
                                    } else {
                                        path.quadraticTo(extendX, startY, extendX, startY + bendR)
                                        path.lineTo(extendX, routeY - bendR)
                                        path.quadraticTo(extendX, routeY, extendX - bendR, routeY)
                                    }
                                    // Go all the way left past the approach point
                                    path.lineTo(approachX + bendR, routeY)
                                    if (routeY < endY) {
                                        path.quadraticTo(approachX, routeY, approachX, routeY + bendR)
                                        path.lineTo(approachX, endY - bendR)
                                        path.quadraticTo(approachX, endY, approachX + bendR, endY)
                                    } else {
                                        path.quadraticTo(approachX, routeY, approachX, routeY - bendR)
                                        path.lineTo(approachX, endY + bendR)
                                        path.quadraticTo(approachX, endY, approachX + bendR, endY)
                                    }
                                    // Final approach from left to entry
                                    path.lineTo(endX, endY)
                                }
                            }
                            "top" -> {
                                // Exit up, must still enter from left
                                val extendY = startY - padding
                                val bendR = min(r, padding / 2)

                                // Go up from exit
                                path.lineTo(startX, extendY + bendR)
                                path.quadraticTo(startX, extendY, startX + (if (approachX > startX) bendR else -bendR), extendY)

                                // Route to approach point X
                                if (approachX > startX) {
                                    // Approach is to the right - go right then down
                                    path.lineTo(approachX - bendR, extendY)
                                    if (endY > extendY) {
                                        path.quadraticTo(approachX, extendY, approachX, extendY + bendR)
                                        path.lineTo(approachX, endY - bendR)
                                        path.quadraticTo(approachX, endY, approachX + bendR, endY)
                                    } else {
                                        path.quadraticTo(approachX, extendY, approachX, extendY - bendR)
                                        path.lineTo(approachX, endY + bendR)
                                        path.quadraticTo(approachX, endY, approachX + bendR, endY)
                                    }
                                } else {
                                    // Approach is to the left - go left then down
                                    path.lineTo(approachX + bendR, extendY)
                                    if (endY > extendY) {
                                        path.quadraticTo(approachX, extendY, approachX, extendY + bendR)
                                        path.lineTo(approachX, endY - bendR)
                                        path.quadraticTo(approachX, endY, approachX + bendR, endY)
                                    } else {
                                        path.quadraticTo(approachX, extendY, approachX, extendY - bendR)
                                        path.lineTo(approachX, endY + bendR)
                                        path.quadraticTo(approachX, endY, approachX + bendR, endY)
                                    }
                                }
                                // Final approach from left
                                path.lineTo(endX, endY)
                            }
                            else -> { // bottom
                                // Exit down, must still enter from left
                                val extendY = startY + padding
                                val bendR = min(r, padding / 2)

                                // Go down from exit
                                path.lineTo(startX, extendY - bendR)
                                path.quadraticTo(startX, extendY, startX + (if (approachX > startX) bendR else -bendR), extendY)

                                // Route to approach point X
                                if (approachX > startX) {
                                    // Approach is to the right - go right then up/down
                                    path.lineTo(approachX - bendR, extendY)
                                    if (endY > extendY) {
                                        path.quadraticTo(approachX, extendY, approachX, extendY + bendR)
                                        path.lineTo(approachX, endY - bendR)
                                        path.quadraticTo(approachX, endY, approachX + bendR, endY)
                                    } else {
                                        path.quadraticTo(approachX, extendY, approachX, extendY - bendR)
                                        path.lineTo(approachX, endY + bendR)
                                        path.quadraticTo(approachX, endY, approachX + bendR, endY)
                                    }
                                } else {
                                    // Approach is to the left - go left then up/down
                                    path.lineTo(approachX + bendR, extendY)
                                    if (endY > extendY) {
                                        path.quadraticTo(approachX, extendY, approachX, extendY + bendR)
                                        path.lineTo(approachX, endY - bendR)
                                        path.quadraticTo(approachX, endY, approachX + bendR, endY)
                                    } else {
                                        path.quadraticTo(approachX, extendY, approachX, extendY - bendR)
                                        path.lineTo(approachX, endY + bendR)
                                        path.quadraticTo(approachX, endY, approachX + bendR, endY)
                                    }
                                }
                                // Final approach from left
                                path.lineTo(endX, endY)
                            }
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
                onZoomOut = { zoomAroundCenter((scale / 1.2f).coerceAtLeast(0.05f)) },
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
 * D3-style disjoint force-directed layout algorithm.
 * Uses four forces (matching D3 defaults):
 * 1. Link force: attraction between connected nodes (distance=30, adaptive strength)
 * 2. Charge force: repulsion between ALL nodes (strength=-30)
 * 3. forceX: pull toward center X (strength=0.1)
 * 4. forceY: pull toward center Y (strength=0.1)
 */
private fun computeNodePositions(
    screens: List<ScreenNode>,
    transitions: List<ScreenTransition>,
    density: androidx.compose.ui.unit.Density,
): List<NodePosition> {
    if (screens.isEmpty()) return emptyList()

    // Build edges and compute node degrees (for adaptive link strength)
    val screenNames = screens.map { it.name }.toSet()
    val edges = mutableListOf<Triple<String, String, Float>>() // source, target, strength
    val degree = mutableMapOf<String, Int>()

    // First pass: count degrees
    transitions.forEach { t ->
        if (t.fromScreen in screenNames && t.toScreen in screenNames) {
            degree[t.fromScreen] = (degree[t.fromScreen] ?: 0) + 1
            degree[t.toScreen] = (degree[t.toScreen] ?: 0) + 1
        }
    }

    // Second pass: build edges with D3-style adaptive strength
    val seenEdges = mutableSetOf<Pair<String, String>>()
    transitions.forEach { t ->
        if (t.fromScreen in screenNames && t.toScreen in screenNames) {
            val edge = if (t.fromScreen < t.toScreen) Pair(t.fromScreen, t.toScreen) else Pair(t.toScreen, t.fromScreen)
            if (edge !in seenEdges) {
                seenEdges.add(edge)
                // D3 link strength: 1 / min(degree(source), degree(target))
                val strength = 1f / minOf(degree[t.fromScreen] ?: 1, degree[t.toScreen] ?: 1)
                edges.add(Triple(t.fromScreen, t.toScreen, strength))
            }
        }
    }

    // Parameters tuned for our node size (80x140dp)
    val nodeWidth = with(density) { NODE_WIDTH.toPx() }
    val nodeHeight = with(density) { NODE_HEIGHT.toPx() }
    val minNodeDistance = kotlin.math.sqrt(nodeWidth * nodeWidth + nodeHeight * nodeHeight) * 1.2f  // Node diagonal + padding
    val linkDistance = with(density) { 300.dp.toPx() }  // Enough space between connected nodes
    val chargeStrength = -15000f  // Base repulsion (leaves get weak, hubs get strong)
    val centerStrength = 0.03f   // Centering to keep things on screen

    // Initialize positions in a circle (better than grid for force layout)
    val positions = mutableMapOf<String, Pair<Float, Float>>()
    val velocities = mutableMapOf<String, Pair<Float, Float>>()
    val radius = linkDistance * kotlin.math.sqrt(screens.size.toFloat())

    screens.forEachIndexed { index, screen ->
        val angle = 2 * kotlin.math.PI * index / screens.size
        positions[screen.name] = Pair(
            (radius * kotlin.math.cos(angle)).toFloat(),
            (radius * kotlin.math.sin(angle)).toFloat()
        )
        velocities[screen.name] = Pair(0f, 0f)
    }

    // Center is at origin (0, 0)
    val centerX = 0f
    val centerY = 0f

    // D3-style force simulation parameters
    var alpha = 1f
    val alphaMin = 0.001f
    val alphaDecay = 0.0228f  // D3 default: 1 - pow(0.001, 1/300)
    val alphaTarget = 0f
    val velocityDecay = 0.4f  // D3 default friction

    // Run simulation until alpha < alphaMin (~300 iterations)
    while (alpha >= alphaMin) {
        // Update alpha (exponential cooling toward target)
        alpha += (alphaTarget - alpha) * alphaDecay

        val forces = screens.associate { it.name to Pair(0f, 0f) }.toMutableMap()

        // 1. CHARGE FORCE (many-body repulsion) - simple like D3
        for (i in screens.indices) {
            for (j in i + 1 until screens.size) {
                val node1 = screens[i].name
                val node2 = screens[j].name
                val pos1 = positions[node1]!!
                val pos2 = positions[node2]!!

                var dx = pos2.first - pos1.first
                var dy = pos2.second - pos1.second
                var dist = kotlin.math.sqrt(dx * dx + dy * dy)

                if (dist < 1f) {
                    dx = (Math.random().toFloat() - 0.5f)
                    dy = (Math.random().toFloat() - 0.5f)
                    dist = kotlin.math.sqrt(dx * dx + dy * dy)
                }

                // Simple charge force like D3 default
                val force = chargeStrength * alpha / dist
                val fx = force * dx / dist
                val fy = force * dy / dist

                forces[node1] = Pair(forces[node1]!!.first - fx, forces[node1]!!.second - fy)
                forces[node2] = Pair(forces[node2]!!.first + fx, forces[node2]!!.second + fy)
            }
        }

        // 2. COLLISION FORCE (like D3 forceCollide) - prevent overlap
        for (i in screens.indices) {
            for (j in i + 1 until screens.size) {
                val node1 = screens[i].name
                val node2 = screens[j].name
                val pos1 = positions[node1]!!
                val pos2 = positions[node2]!!

                var dx = pos2.first - pos1.first
                var dy = pos2.second - pos1.second
                val dist = kotlin.math.sqrt(dx * dx + dy * dy)

                if (dist < minNodeDistance && dist > 0) {
                    // Push nodes apart to reach minNodeDistance
                    val overlap = minNodeDistance - dist
                    val pushStrength = overlap * 0.5f  // Each node moves half the overlap
                    val nx = dx / dist
                    val ny = dy / dist

                    forces[node1] = Pair(forces[node1]!!.first - nx * pushStrength, forces[node1]!!.second - ny * pushStrength)
                    forces[node2] = Pair(forces[node2]!!.first + nx * pushStrength, forces[node2]!!.second + ny * pushStrength)
                }
            }
        }

        // 3. LINK FORCE - always pull connected nodes closer (minimize link length)
        edges.forEach { (source, target, strength) ->
            val pos1 = positions[source]!!
            val pos2 = positions[target]!!

            val dx = pos2.first - pos1.first
            val dy = pos2.second - pos1.second
            val dist = kotlin.math.sqrt(dx * dx + dy * dy)

            if (dist > minNodeDistance) {
                // Pull toward each other - strength proportional to distance
                val pullStrength = (dist - minNodeDistance) * 0.05f * alpha * strength
                val nx = dx / dist
                val ny = dy / dist

                forces[source] = Pair(forces[source]!!.first + nx * pullStrength, forces[source]!!.second + ny * pullStrength)
                forces[target] = Pair(forces[target]!!.first - nx * pullStrength, forces[target]!!.second - ny * pullStrength)
            }
        }

        // 4. POSITION FORCES (forceX, forceY) + time-based horizontal bias
        // Older screens pull left, newer screens (>50% median) pull right
        val sortedByTime = screens.sortedBy { it.discoveredAt }
        val medianTime = sortedByTime[sortedByTime.size / 2].discoveredAt
        val oldestTime = sortedByTime.first().discoveredAt
        val newestTime = sortedByTime.last().discoveredAt
        val timeRange = (newestTime - oldestTime).coerceAtLeast(1L)

        screens.forEach { screen ->
            val pos = positions[screen.name]!!

            // Base centering force (Y only - let X be controlled by time)
            val fy = (centerY - pos.second) * centerStrength * alpha

            // Time-based X force: older = left, newer = right
            val timePosition = (screen.discoveredAt - oldestTime).toFloat() / timeRange // 0 = oldest, 1 = newest
            val targetX = if (screen.discoveredAt <= medianTime) {
                // Older than median: pull left (stronger for oldest)
                centerX - (1f - timePosition) * minNodeDistance * 3f
            } else {
                // Newer than median: pull slightly right
                centerX + timePosition * minNodeDistance * 1.5f
            }
            val fx = (targetX - pos.first) * centerStrength * 2f * alpha

            forces[screen.name] = Pair(
                forces[screen.name]!!.first + fx,
                forces[screen.name]!!.second + fy
            )
        }

        // Apply forces using velocity Verlet integration
        screens.forEach { screen ->
            val vel = velocities[screen.name]!!
            val force = forces[screen.name]!!

            // Add force to velocity
            var vx = vel.first + force.first
            var vy = vel.second + force.second

            // Apply velocity decay (friction)
            vx *= (1f - velocityDecay)
            vy *= (1f - velocityDecay)

            velocities[screen.name] = Pair(vx, vy)

            // Update position
            val pos = positions[screen.name]!!
            positions[screen.name] = Pair(pos.first + vx, pos.second + vy)
        }
    }

    // POST-PROCESS: Run collision resolution passes to eliminate remaining overlaps
    var collisionIterations = 0
    while (collisionIterations < 100) {
        collisionIterations++
        var anyOverlap = false
        for (i in screens.indices) {
            for (j in i + 1 until screens.size) {
                val node1 = screens[i].name
                val node2 = screens[j].name
                val pos1 = positions[node1]!!
                val pos2 = positions[node2]!!

                var dx = pos2.first - pos1.first
                var dy = pos2.second - pos1.second
                val dist = kotlin.math.sqrt(dx * dx + dy * dy)

                if (dist < minNodeDistance) {
                    anyOverlap = true
                    if (dist > 0.1f) {
                        val overlap = (minNodeDistance - dist) / 2f + 1f
                        val nx = dx / dist
                        val ny = dy / dist
                        positions[node1] = Pair(pos1.first - nx * overlap, pos1.second - ny * overlap)
                        positions[node2] = Pair(pos2.first + nx * overlap, pos2.second + ny * overlap)
                    } else {
                        // Nodes at same position - push apart randomly
                        val angle = Math.random() * 2 * kotlin.math.PI
                        val push = minNodeDistance / 2f
                        positions[node1] = Pair(pos1.first - (push * kotlin.math.cos(angle)).toFloat(), pos1.second - (push * kotlin.math.sin(angle)).toFloat())
                        positions[node2] = Pair(pos2.first + (push * kotlin.math.cos(angle)).toFloat(), pos2.second + (push * kotlin.math.sin(angle)).toFloat())
                    }
                }
            }
        }
        if (!anyOverlap) break  // Early exit if no overlaps
    }

    // Center the result in the viewport
    val minX = positions.values.minOfOrNull { it.first } ?: 0f
    val minY = positions.values.minOfOrNull { it.second } ?: 0f

    // Add padding from top-left
    val paddingX = 100f
    val paddingY = 100f

    return screens.map { screen ->
        val pos = positions[screen.name]!!
        NodePosition(
            screenId = screen.name,
            x = pos.first - minX + paddingX,
            y = pos.second - minY + paddingY
        )
    }
}
