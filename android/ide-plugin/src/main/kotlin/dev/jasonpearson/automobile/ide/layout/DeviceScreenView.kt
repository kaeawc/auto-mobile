@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.ide.layout

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.onPointerEvent
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.jetbrains.jewel.foundation.theme.JewelTheme
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.skia.Image
import kotlin.math.roundToInt

/**
 * Device screen view with screenshot display, zoom/pan controls, and element overlays.
 * Supports:
 * - Zoom via scroll wheel (centered on cursor)
 * - Pan via mouse drag
 * - Click to select elements (finds deepest element at point)
 * - Hover highlighting
 * - Selected element overlay (blue border)
 * - Hovered element overlay (gray border)
 */
@Composable
fun DeviceScreenView(
    screenshotData: ByteArray?,
    screenWidth: Int,
    screenHeight: Int,
    hierarchy: UIElementInfo?,
    selectedElementId: String?,
    hoveredElementId: String?,
    onElementSelected: (String?) -> Unit,
    onElementHovered: (String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = JewelTheme.globalColors

    // Zoom and pan state
    var scale by remember { mutableFloatStateOf(1f) }
    var offsetX by remember { mutableFloatStateOf(0f) }
    var offsetY by remember { mutableFloatStateOf(0f) }
    var hasInitialFit by remember { mutableStateOf(false) }

    // Decode screenshot to ImageBitmap
    val imageBitmap = remember(screenshotData) {
        screenshotData?.let {
            try {
                val skiaImage = Image.makeFromEncoded(it)
                skiaImage.toComposeImageBitmap()
            } catch (e: Exception) {
                null
            }
        }
    }

    // Find selected and hovered elements
    val selectedElement = remember(hierarchy, selectedElementId) {
        if (hierarchy != null && selectedElementId != null) {
            LayoutInspectorMockData.findElementById(hierarchy, selectedElementId)
        } else null
    }

    val hoveredElement = remember(hierarchy, hoveredElementId) {
        if (hierarchy != null && hoveredElementId != null) {
            LayoutInspectorMockData.findElementById(hierarchy, hoveredElementId)
        } else null
    }

    Column(modifier = modifier) {
        // Screenshot viewport
        BoxWithConstraints(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .background(colors.text.normal.copy(alpha = 0.03f))
        ) {
            val viewportWidth = constraints.maxWidth.toFloat()
            val viewportHeight = constraints.maxHeight.toFloat()

            // Auto-fit on initial load
            LaunchedEffect(viewportWidth, viewportHeight, screenWidth, screenHeight) {
                if (!hasInitialFit && viewportWidth > 0 && viewportHeight > 0 && screenWidth > 0) {
                    // Calculate scale to fit device screen in viewport with padding
                    val padding = 32f
                    val scaleX = (viewportWidth - padding * 2) / screenWidth
                    val scaleY = (viewportHeight - padding * 2) / screenHeight
                    val newScale = minOf(scaleX, scaleY, 1f).coerceIn(0.1f, 1f)

                    // Center the device screen
                    val scaledWidth = screenWidth * newScale
                    val scaledHeight = screenHeight * newScale
                    offsetX = (viewportWidth - scaledWidth) / 2
                    offsetY = (viewportHeight - scaledHeight) / 2

                    scale = newScale
                    hasInitialFit = true
                }
            }

            // Zoom helper
            fun zoomAroundPoint(newScale: Float, pivotX: Float, pivotY: Float) {
                val oldScale = scale
                val contentX = (pivotX - offsetX) / oldScale
                val contentY = (pivotY - offsetY) / oldScale
                scale = newScale
                offsetX = pivotX - contentX * newScale
                offsetY = pivotY - contentY * newScale
            }

            fun zoomAroundCenter(newScale: Float) {
                zoomAroundPoint(newScale, viewportWidth / 2, viewportHeight / 2)
            }

            // Convert screen coordinates to device coordinates
            fun screenToDevice(screenX: Float, screenY: Float): Pair<Int, Int> {
                val deviceX = ((screenX - offsetX) / scale).roundToInt()
                val deviceY = ((screenY - offsetY) / scale).roundToInt()
                return deviceX to deviceY
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
                    .pointerInput(hierarchy) {
                        detectTapGestures { offset ->
                            if (hierarchy != null) {
                                val (deviceX, deviceY) = screenToDevice(offset.x, offset.y)
                                val element = LayoutInspectorMockData.findElementAt(hierarchy, deviceX, deviceY)
                                onElementSelected(element?.id)
                            }
                        }
                    }
                    .onPointerEvent(PointerEventType.Move) { event ->
                        if (hierarchy != null) {
                            val pos = event.changes.firstOrNull()?.position
                            if (pos != null) {
                                val (deviceX, deviceY) = screenToDevice(pos.x, pos.y)
                                val element = LayoutInspectorMockData.findElementAt(hierarchy, deviceX, deviceY)
                                onElementHovered(element?.id)
                            }
                        }
                    }
                    .onPointerEvent(PointerEventType.Exit) {
                        onElementHovered(null)
                    }
                    .onPointerEvent(PointerEventType.Scroll) { event ->
                        val change = event.changes.firstOrNull() ?: return@onPointerEvent
                        val scrollDelta = change.scrollDelta.y
                        if (scrollDelta != 0f) {
                            val zoomFactor = if (scrollDelta > 0) 0.95f else 1.05f
                            val newScale = (scale * zoomFactor).coerceIn(0.1f, 5f)
                            zoomAroundPoint(newScale, change.position.x, change.position.y)
                        }
                    }
            ) {
                // Device frame background
                Box(
                    modifier = Modifier
                        .graphicsLayer {
                            scaleX = scale
                            scaleY = scale
                            translationX = offsetX
                            translationY = offsetY
                            transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0f, 0f)
                        }
                        .size(
                            width = screenWidth.dp / androidx.compose.ui.unit.Density(1f).density,
                            height = screenHeight.dp / androidx.compose.ui.unit.Density(1f).density
                        )
                ) {
                    // Screenshot or placeholder
                    if (imageBitmap != null) {
                        Image(
                            bitmap = imageBitmap,
                            contentDescription = "Device screenshot",
                            modifier = Modifier
                                .fillMaxSize()
                                .drawWithContent {
                                    drawContent()

                                    // Draw element overlays
                                    // Hovered element (gray)
                                    if (hoveredElement != null && hoveredElement.id != selectedElementId) {
                                        val bounds = hoveredElement.bounds
                                        drawRect(
                                            color = Color.Gray.copy(alpha = 0.5f),
                                            topLeft = Offset(bounds.left.toFloat(), bounds.top.toFloat()),
                                            size = Size(bounds.width.toFloat(), bounds.height.toFloat()),
                                            style = Stroke(width = 2f),
                                        )
                                    }

                                    // Selected element (blue)
                                    if (selectedElement != null) {
                                        val bounds = selectedElement.bounds
                                        drawRect(
                                            color = Color(0xFF2196F3),
                                            topLeft = Offset(bounds.left.toFloat(), bounds.top.toFloat()),
                                            size = Size(bounds.width.toFloat(), bounds.height.toFloat()),
                                            style = Stroke(width = 3f),
                                        )
                                        // Fill with semi-transparent blue
                                        drawRect(
                                            color = Color(0xFF2196F3).copy(alpha = 0.1f),
                                            topLeft = Offset(bounds.left.toFloat(), bounds.top.toFloat()),
                                            size = Size(bounds.width.toFloat(), bounds.height.toFloat()),
                                        )
                                    }
                                }
                        )
                    } else {
                        // Placeholder device frame
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .background(Color(0xFF1A1A1A))
                                .border(2.dp, Color(0xFF333333), RoundedCornerShape(8.dp)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Text(
                                    "No Screenshot",
                                    color = colors.text.normal.copy(alpha = 0.5f),
                                    fontSize = 14.sp,
                                )
                                Text(
                                    "Connect to device to view",
                                    color = colors.text.normal.copy(alpha = 0.3f),
                                    fontSize = 11.sp,
                                )
                            }
                        }
                    }
                }

                // Zoom controls
                ZoomControls(
                    scale = scale,
                    onZoomIn = { zoomAroundCenter((scale * 1.2f).coerceAtMost(5f)) },
                    onZoomOut = { zoomAroundCenter((scale / 1.2f).coerceAtLeast(0.1f)) },
                    onFitToScreen = {
                        if (screenWidth > 0 && screenHeight > 0) {
                            val padding = 32f
                            val scaleX = (viewportWidth - padding * 2) / screenWidth
                            val scaleY = (viewportHeight - padding * 2) / screenHeight
                            val newScale = minOf(scaleX, scaleY, 1f).coerceIn(0.1f, 1f)
                            val scaledWidth = screenWidth * newScale
                            val scaledHeight = screenHeight * newScale
                            scale = newScale
                            offsetX = (viewportWidth - scaledWidth) / 2
                            offsetY = (viewportHeight - scaledHeight) / 2
                        }
                    },
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(8.dp),
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
    onFitToScreen: () -> Unit,
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
        ZoomButton("-", onClick = onZoomOut)
        ZoomButton("\u2922", onClick = onFitToScreen) // Fit icon

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
