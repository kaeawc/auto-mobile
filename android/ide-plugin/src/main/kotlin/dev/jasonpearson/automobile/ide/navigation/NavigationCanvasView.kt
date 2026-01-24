@file:OptIn(ExperimentalFoundationApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.ide.navigation

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
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
import kotlin.math.sqrt

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

    // Hover state for highlighting
    var hoveredScreenName by remember { mutableStateOf<String?>(null) }
    var hoveredTransitionId by remember { mutableStateOf<String?>(null) }

    // Mouse position for edge hover detection
    var mouseX by remember { mutableFloatStateOf(0f) }
    var mouseY by remember { mutableFloatStateOf(0f) }

    // Compute highlighted elements based on hover state
    val highlightedScreens = remember(hoveredScreenName, hoveredTransitionId, transitions) {
        when {
            hoveredScreenName != null -> {
                // Highlight hovered screen and all connected screens
                val connected = mutableSetOf(hoveredScreenName!!)
                transitions.filter { it.trigger != "back" }.forEach { t ->
                    if (t.fromScreen == hoveredScreenName) connected.add(t.toScreen)
                    if (t.toScreen == hoveredScreenName) connected.add(t.fromScreen)
                }
                connected
            }
            hoveredTransitionId != null -> {
                // Highlight screens at both ends of the hovered edge
                val transition = transitions.find { it.id == hoveredTransitionId }
                if (transition != null) setOf(transition.fromScreen, transition.toScreen) else emptySet()
            }
            else -> emptySet()
        }
    }

    val highlightedTransitions = remember(hoveredScreenName, hoveredTransitionId, transitions) {
        when {
            hoveredScreenName != null -> {
                // Highlight all edges connected to hovered screen
                transitions.filter { it.trigger != "back" }
                    .filter { it.fromScreen == hoveredScreenName || it.toScreen == hoveredScreenName }
                    .map { it.id }
                    .toSet()
            }
            hoveredTransitionId != null -> setOf(hoveredTransitionId!!)
            else -> emptySet()
        }
    }

    // Compute edge hit zones for hover detection
    // Each edge is represented by its start and end points (simplified from the full path)
    data class EdgeHitZone(
        val transitionId: String,
        val startX: Float,
        val startY: Float,
        val endX: Float,
        val endY: Float,
    )

    // Helper to compute distance from point to line segment
    fun distanceToSegment(px: Float, py: Float, x1: Float, y1: Float, x2: Float, y2: Float): Float {
        val dx = x2 - x1
        val dy = y2 - y1
        val lengthSquared = dx * dx + dy * dy

        if (lengthSquared == 0f) {
            // Segment is a point
            return sqrt((px - x1) * (px - x1) + (py - y1) * (py - y1))
        }

        // Project point onto segment, clamped to [0, 1]
        val t = maxOf(0f, minOf(1f, ((px - x1) * dx + (py - y1) * dy) / lengthSquared))

        // Find projection point
        val projX = x1 + t * dx
        val projY = y1 + t * dy

        return sqrt((px - projX) * (px - projX) + (py - projY) * (py - projY))
    }

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

    // Compute edge hit zones
    val edgeHitZones = remember(transitions, positionByName, nodeWidthPx, nodeHeightPx) {
        val forwardTransitions = transitions.filter { it.trigger != "back" }
        forwardTransitions.mapNotNull { transition ->
            val fromPos = positionByName[transition.fromScreen]
            val toPos = positionByName[transition.toScreen]
            if (fromPos != null && toPos != null) {
                EdgeHitZone(
                    transitionId = transition.id,
                    startX = fromPos.x + nodeWidthPx,  // Right edge of source
                    startY = fromPos.y + nodeHeightPx / 2,  // Center Y
                    endX = toPos.x,  // Left edge of target
                    endY = toPos.y + nodeHeightPx / 2,  // Center Y
                )
            } else null
        }
    }

    // Check edge hover when mouse moves (only if not hovering a screen)
    LaunchedEffect(mouseX, mouseY, edgeHitZones, scale, offsetX, offsetY, hoveredScreenName) {
        if (hoveredScreenName != null) {
            // Screen hover takes precedence - clear edge hover
            if (hoveredTransitionId != null) {
                hoveredTransitionId = null
            }
        } else {
            val hitThreshold = 15f  // Pixels from edge line to count as hit
            val detectedEdge = edgeHitZones.find { zone ->
                // Transform edge points to screen coordinates
                val sx = zone.startX * scale + offsetX
                val sy = zone.startY * scale + offsetY
                val ex = zone.endX * scale + offsetX
                val ey = zone.endY * scale + offsetY
                distanceToSegment(mouseX, mouseY, sx, sy, ex, ey) < hitThreshold
            }?.transitionId

            if (detectedEdge != hoveredTransitionId) {
                hoveredTransitionId = detectedEdge
            }
        }
    }
    val arrowColor = colors.text.normal.copy(alpha = 0.3f)
    val highlightedArrowColor = Color(0xFF4CAF50)  // Green highlight
    val dimmedArrowColor = colors.text.normal.copy(alpha = 0.1f)  // Dimmed when something else is highlighted

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
                .onPointerEvent(PointerEventType.Move) { event ->
                    val pos = event.changes.firstOrNull()?.position
                    if (pos != null) {
                        mouseX = pos.x
                        mouseY = pos.y
                    }
                }
                .onPointerEvent(PointerEventType.Exit) {
                    // Clear edge hover when mouse leaves canvas
                    if (hoveredScreenName == null) {
                        hoveredTransitionId = null
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

                // Build list of all node bounds for collision detection
                data class NodeBounds(val name: String, val left: Float, val top: Float, val right: Float, val bottom: Float)
                val allNodeBounds = nodePositions.map { pos ->
                    NodeBounds(
                        name = pos.screenId,
                        left = pos.x * scale + offsetX,
                        top = pos.y * scale + offsetY,
                        right = (pos.x + nodeWidthPx) * scale + offsetX,
                        bottom = (pos.y + nodeHeightPx) * scale + offsetY
                    )
                }

                // Helper to check if a horizontal line segment intersects any node (excluding specific nodes)
                val collisionMargin = 15f * scale  // Larger margin for better clearance
                fun horizontalLineHitsNode(y: Float, x1: Float, x2: Float, excludeNodes: Set<String>): NodeBounds? {
                    val minX = minOf(x1, x2)
                    val maxX = maxOf(x1, x2)
                    return allNodeBounds.firstOrNull { node ->
                        node.name !in excludeNodes &&
                        y >= node.top - collisionMargin && y <= node.bottom + collisionMargin &&
                        maxX >= node.left - collisionMargin && minX <= node.right + collisionMargin
                    }
                }

                // Helper to check if a vertical line segment intersects any node
                fun verticalLineHitsNode(x: Float, y1: Float, y2: Float, excludeNodes: Set<String>): NodeBounds? {
                    val minY = minOf(y1, y2)
                    val maxY = maxOf(y1, y2)
                    return allNodeBounds.firstOrNull { node ->
                        node.name !in excludeNodes &&
                        x >= node.left - collisionMargin && x <= node.right + collisionMargin &&
                        maxY >= node.top - collisionMargin && minY <= node.bottom + collisionMargin
                    }
                }

                // Find all nodes that a rectangular region intersects
                fun nodesInRegion(x1: Float, y1: Float, x2: Float, y2: Float, excludeNodes: Set<String>): List<NodeBounds> {
                    val minX = minOf(x1, x2)
                    val maxX = maxOf(x1, x2)
                    val minY = minOf(y1, y2)
                    val maxY = maxOf(y1, y2)
                    return allNodeBounds.filter { node ->
                        node.name !in excludeNodes &&
                        maxX >= node.left - collisionMargin && minX <= node.right + collisionMargin &&
                        maxY >= node.top - collisionMargin && minY <= node.bottom + collisionMargin
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
                        val fromLeft = fromPos.x * scale + offsetX

                        val toLeft = toPos.x * scale + offsetX
                        val toRight = (toPos.x + nodeWidthPx) * scale + offsetX
                        val toCenterY = (toPos.y + nodeHeightPx / 2) * scale + offsetY
                        val toTop = toPos.y * scale + offsetY
                        val toBottom = (toPos.y + nodeHeightPx) * scale + offsetY

                        val excludeNodes = setOf(transition.fromScreen, transition.toScreen)

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

                        // Draw orthogonal path that avoids crossing source/target nodes AND intermediate nodes
                        // Rule: edges MUST always approach entry point from the LEFT
                        val path = Path()
                        val r = cornerRadius
                        val padding = 30f * scale  // Clearance around nodes
                        val approachDistance = 40f * scale  // How far left of entry to start horizontal approach

                        // The approach point is always to the LEFT of the entry point
                        val approachX = endX - approachDistance

                        path.moveTo(startX, startY)

                        when (exitSide) {
                            "right" -> {
                                // Check if direct horizontal path is clear (same Y level)
                                val directPathClear = abs(endY - startY) < nodeHeightPx * scale * 0.3f &&
                                    horizontalLineHitsNode(startY, startX, endX, excludeNodes) == null

                                if (directPathClear) {
                                    // Simple straight line
                                    path.lineTo(endX, endY)
                                } else {
                                    // Check if simple 2-bend route works (go right, then up/down to end)
                                    val midX = (startX + endX) / 2
                                    val simpleVerticalHit = verticalLineHitsNode(midX, startY, endY, excludeNodes)
                                    val simpleHorizontalHit1 = horizontalLineHitsNode(startY, startX, midX, excludeNodes)
                                    val simpleHorizontalHit2 = horizontalLineHitsNode(endY, midX, endX, excludeNodes)

                                    if (simpleVerticalHit == null && simpleHorizontalHit1 == null && simpleHorizontalHit2 == null) {
                                        // Simple 2-bend route: right → down/up → right
                                        val bendR = min(r, min(abs(midX - startX), abs(endY - startY).coerceAtLeast(1f)) / 2)
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
                                    } else {
                                        // Need to route around blocking nodes - find clear path above or below
                                        val allBlockingNodes = nodesInRegion(startX, minOf(startY, endY) - padding, endX, maxOf(startY, endY) + padding, excludeNodes)

                                        val topRoute = if (allBlockingNodes.isEmpty()) {
                                            minOf(startY, endY) - padding
                                        } else {
                                            allBlockingNodes.minOf { it.top } - padding * 1.5f
                                        }
                                        val bottomRoute = if (allBlockingNodes.isEmpty()) {
                                            maxOf(startY, endY) + padding
                                        } else {
                                            allBlockingNodes.maxOf { it.bottom } + padding * 1.5f
                                        }

                                        // Choose route closer to average Y
                                        val avgY = (startY + endY) / 2
                                        val routeY = if (abs(topRoute - avgY) < abs(bottomRoute - avgY)) topRoute else bottomRoute

                                        val bendR = min(r, min(abs(midX - startX), abs(routeY - startY).coerceAtLeast(padding)) / 2)

                                        path.lineTo(midX - bendR, startY)
                                        if (routeY > startY) {
                                            path.quadraticTo(midX, startY, midX, startY + bendR)
                                            path.lineTo(midX, routeY - bendR)
                                            path.quadraticTo(midX, routeY, midX + bendR, routeY)
                                        } else if (routeY < startY) {
                                            path.quadraticTo(midX, startY, midX, startY - bendR)
                                            path.lineTo(midX, routeY + bendR)
                                            path.quadraticTo(midX, routeY, midX + bendR, routeY)
                                        } else {
                                            path.lineTo(midX + bendR, routeY)
                                        }

                                        // Go to end, adjusting Y if needed
                                        if (abs(routeY - endY) > 1f) {
                                            path.lineTo(approachX - bendR, routeY)
                                            if (endY > routeY) {
                                                path.quadraticTo(approachX, routeY, approachX, routeY + bendR)
                                                path.lineTo(approachX, endY - bendR)
                                                path.quadraticTo(approachX, endY, approachX + bendR, endY)
                                            } else {
                                                path.quadraticTo(approachX, routeY, approachX, routeY - bendR)
                                                path.lineTo(approachX, endY + bendR)
                                                path.quadraticTo(approachX, endY, approachX + bendR, endY)
                                            }
                                        }
                                        path.lineTo(endX, endY)
                                    }
                                }
                            }
                            "top" -> {
                                // Exit up - find all nodes in the horizontal range and route above them
                                val blockingNodes = nodesInRegion(
                                    minOf(startX, approachX) - padding,
                                    Float.MIN_VALUE,
                                    maxOf(startX, approachX, endX) + padding,
                                    startY
                                , excludeNodes)
                                val extendY = if (blockingNodes.isEmpty()) {
                                    startY - padding * 1.5f
                                } else {
                                    blockingNodes.minOf { it.top } - padding * 1.5f
                                }
                                val bendR = min(r, padding / 2)

                                // Go up from exit
                                path.lineTo(startX, extendY + bendR)
                                path.quadraticTo(startX, extendY, startX + (if (approachX > startX) bendR else -bendR), extendY)

                                // Route to approach point X
                                if (approachX > startX) {
                                    path.lineTo(approachX - bendR, extendY)
                                } else {
                                    path.lineTo(approachX + bendR, extendY)
                                }

                                // Go down to end Y
                                if (endY > extendY) {
                                    path.quadraticTo(approachX, extendY, approachX, extendY + bendR)
                                    path.lineTo(approachX, endY - bendR)
                                    path.quadraticTo(approachX, endY, approachX + bendR, endY)
                                } else {
                                    path.quadraticTo(approachX, extendY, approachX, extendY - bendR)
                                    path.lineTo(approachX, endY + bendR)
                                    path.quadraticTo(approachX, endY, approachX + bendR, endY)
                                }
                                path.lineTo(endX, endY)
                            }
                            else -> { // bottom
                                // Exit down - find all nodes in the horizontal range and route below them
                                val blockingNodes = nodesInRegion(
                                    minOf(startX, approachX) - padding,
                                    startY,
                                    maxOf(startX, approachX, endX) + padding,
                                    Float.MAX_VALUE
                                , excludeNodes)
                                val extendY = if (blockingNodes.isEmpty()) {
                                    startY + padding * 1.5f
                                } else {
                                    blockingNodes.maxOf { it.bottom } + padding * 1.5f
                                }
                                val bendR = min(r, padding / 2)

                                // Go down from exit
                                path.lineTo(startX, extendY - bendR)
                                path.quadraticTo(startX, extendY, startX + (if (approachX > startX) bendR else -bendR), extendY)

                                // Route to approach point X
                                if (approachX > startX) {
                                    path.lineTo(approachX - bendR, extendY)
                                } else {
                                    path.lineTo(approachX + bendR, extendY)
                                }

                                // Go up to end Y
                                if (endY > extendY) {
                                    path.quadraticTo(approachX, extendY, approachX, extendY + bendR)
                                    path.lineTo(approachX, endY - bendR)
                                    path.quadraticTo(approachX, endY, approachX + bendR, endY)
                                } else {
                                    path.quadraticTo(approachX, extendY, approachX, extendY - bendR)
                                    path.lineTo(approachX, endY + bendR)
                                    path.quadraticTo(approachX, endY, approachX + bendR, endY)
                                }
                                path.lineTo(endX, endY)
                            }
                        }

                        // Determine edge color based on highlight state
                        val isHighlighted = transition.id in highlightedTransitions
                        val hasAnyHighlight = highlightedScreens.isNotEmpty() || highlightedTransitions.isNotEmpty()
                        val edgeColor = when {
                            isHighlighted -> highlightedArrowColor
                            hasAnyHighlight -> dimmedArrowColor
                            else -> arrowColor
                        }
                        val edgeStrokeWidth = if (isHighlighted) strokeWidth * 1.5f else strokeWidth

                        drawPath(
                            path = path,
                            color = edgeColor,
                            style = Stroke(width = edgeStrokeWidth, cap = StrokeCap.Round),
                        )
                    }
                }
                }
        ) {
            // Render screen nodes as Composables
            nodePositions.forEach { pos ->
                val screen = screenByName[pos.screenId] ?: return@forEach

                val hasAnyHighlight = highlightedScreens.isNotEmpty() || highlightedTransitions.isNotEmpty()

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
                        isHighlighted = screen.name in highlightedScreens,
                        isDimmed = hasAnyHighlight && screen.name !in highlightedScreens,
                        onClick = { onScreenSelected(screen.id) },
                        onHoverChange = { isHovered ->
                            hoveredScreenName = if (isHovered) screen.name else null
                        },
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
    isHighlighted: Boolean,
    isDimmed: Boolean,
    onClick: () -> Unit,
    onHoverChange: (Boolean) -> Unit,
) {
    val colors = JewelTheme.globalColors
    val coverageColor = when {
        screen.testCoverage >= 80 -> Color(0xFF4CAF50)
        screen.testCoverage >= 50 -> Color(0xFFFFC107)
        else -> Color(0xFFFF5722)
    }

    // Visual states based on highlighting
    val bgAlpha = when {
        isHighlighted -> 0.25f
        isDimmed -> 0.05f
        else -> 0.1f
    }
    val borderColor = if (isHighlighted) Color(0xFF4CAF50) else Color.Transparent
    val textAlpha = if (isDimmed) 0.4f else 0.8f

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
                .background(colors.text.normal.copy(alpha = bgAlpha), RoundedCornerShape(8.dp))
                .then(
                    if (isHighlighted) Modifier.border(2.dp, borderColor, RoundedCornerShape(8.dp))
                    else Modifier
                )
                .clickable(onClick = onClick)
                .pointerHoverIcon(PointerIcon.Hand)
                .onPointerEvent(PointerEventType.Enter) { onHoverChange(true) }
                .onPointerEvent(PointerEventType.Exit) { onHoverChange(false) }
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
                color = colors.text.normal.copy(alpha = textAlpha),
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
                    color = colors.text.normal.copy(alpha = if (isDimmed) 0.3f else 0.5f),
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

    // Simple grid layout based on discovery order
    val nodeWidth = with(density) { NODE_WIDTH.toPx() }
    val nodeHeight = with(density) { NODE_HEIGHT.toPx() }
    val horizontalSpacing = nodeWidth * 1.8f
    val verticalSpacing = nodeHeight * 1.4f

    // Sort by discovery time and lay out left-to-right
    val sortedScreens = screens.sortedBy { it.discoveredAt }
    val positions = mutableMapOf<String, Pair<Float, Float>>()

    sortedScreens.forEachIndexed { index, screen ->
        positions[screen.name] = Pair(
            index * horizontalSpacing,
            0f
        )
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
