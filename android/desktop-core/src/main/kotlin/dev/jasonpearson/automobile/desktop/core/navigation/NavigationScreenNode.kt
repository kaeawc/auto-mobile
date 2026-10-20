@file:OptIn(ExperimentalFoundationApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.onPointerEvent
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.components.Tooltip
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlinx.coroutines.withContext

@Composable
internal fun ScreenNodeCard(options: ScreenNodeCardOptions) {
  val screenshot = rememberNodeScreenshot(options)
  val style = nodeCardStyle(options)
  Tooltip(tooltip = { NodeTooltip(options, style.isFaded) }) {
    NodeCardBody(options, style, screenshot)
  }
}

private data class NodeScreenshotState(val bitmap: ImageBitmap?, val loading: Boolean)

private data class NodeCardStyle(
  val isHighlighted: Boolean,
  val borderColor: Color,
  val borderWidth: androidx.compose.ui.unit.Dp,
  val textAlpha: Float,
  val isFaded: Boolean,
)

@Composable
private fun rememberNodeScreenshot(options: ScreenNodeCardOptions): NodeScreenshotState =
  with(options) {
    // Screenshot loading state
    var screenshotBitmap by remember { mutableStateOf<ImageBitmap?>(null) }
    var isLoadingScreenshot by remember { mutableStateOf(false) }

    // Load screenshot when available (key on screenshotLoader too, so it re-fires if loader becomes
    // available later). Also key on screenshotVersion: the daemon re-captures a node's screenshot
    // under the SAME stable URI, so without a changing key this effect would never re-fire and the
    // URI-keyed loader cache would keep serving the stale bitmap (#5088). The facet bumps the
    // version
    // for the node whose screenshot was just re-captured; a bump drops that node's cache entry and
    // re-fetches, scoped to exactly this node (no mass refetch of the rest of the graph).
    val screenshotUri = screen.screenshotUri
    val screenshotVersion = screen.screenshotVersion
    LaunchedEffect(screenshotUri, screenshotVersion, screenshotLoader) {
      if (screenshotUri != null && screenshotLoader != null) {
        // Only invalidate on an observed re-capture (version > 0); the first load of a node
        // (version 0) is already a cache miss, so invalidating then would be a redundant no-op.
        if (screenshotVersion > 0) {
          screenshotLoader.invalidate(screenshotUri)
        }
        isLoadingScreenshot = true
        screenshotBitmap =
          withContext(ioDispatcher) {
            screenshotLoader.load(screenshotUri)
          }
        isLoadingScreenshot = false
      } else {
        screenshotBitmap = null
      }
    }

    NodeScreenshotState(screenshotBitmap, isLoadingScreenshot)
  }

private fun nodeCardStyle(options: ScreenNodeCardOptions): NodeCardStyle =
  with(options) {
    val isHighlighted =
      isHovered || isSource || isTarget || isInTestFlow || isCurrentReplayStep || isFogFocused
    val borderWidth =
      when {
        isCurrentReplayStep -> 3.dp
        isFogFocused -> 3.dp
        else -> 2.dp
      }
    val textAlpha = if (isDimmed) 0.4f else 0.8f

    // A faded node was reached only historically / by another build or device (#4985). Surface its
    // provenance in the visible hover tooltip, not only in the semantics contentDescription, so
    // sighted mouse users see the same signal screen readers get.
    val isFaded = provenanceAlpha < ProvenanceOpacity.ACTIVE_ALPHA

    NodeCardStyle(isHighlighted, nodeCardBorderColor(options), borderWidth, textAlpha, isFaded)
  }

private fun nodeCardBorderColor(options: ScreenNodeCardOptions): Color =
  with(options) {
    when {
      isCurrentReplayStep -> Color(0xFF00E676) // Current step is bright Color(0xFF4CAF50)
      isFogFocused -> Color(0xFFFFEB3B) // Fog focus is yellow
      isHovered -> Color(0xFF64B5F6)
      isInTestFlow -> Color(0xFF2196F3)
      isSource -> Color(0xFFFF9800)
      isTarget -> Color(0xFF4CAF50)
      else -> Color.Transparent
    }
  }

@Composable
private fun NodeTooltip(options: ScreenNodeCardOptions, isFaded: Boolean) {
  with(options) {
    val colors = SharedTheme.globalColors

    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(screen.name, fontSize = 12.sp)
      Text(screen.type, fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.7f))
      Text(screen.packageName, fontSize = 10.sp, color = colors.text.normal.copy(alpha = 0.5f))
      if (isFaded && provenanceDescription.isNotEmpty()) {
        Text(
          provenanceDescription,
          fontSize = 10.sp,
          color = colors.text.normal.copy(alpha = 0.7f),
        )
      }
    }
  }
}

@Composable
private fun NodeCardBody(
  options: ScreenNodeCardOptions,
  style: NodeCardStyle,
  screenshot: NodeScreenshotState,
) {
  with(options) {
    with(style) {
      val colors = SharedTheme.globalColors
      val screenshotBitmap = screenshot.bitmap
      val isLoadingScreenshot = screenshot.loading
      Box(
        modifier =
          Modifier.clickable(onClick = onClick)
            .pointerHoverIcon(PointerIcon.Hand)
            .onPointerEvent(PointerEventType.Enter) { onHoverChange(true) }
            .onPointerEvent(PointerEventType.Exit) { onHoverChange(false) }
            // Provenance-weighted opacity: 100% active, 50% historical / other build or device
            // (#4985).
            .graphicsLayer { alpha = provenanceAlpha }
            .semantics { contentDescription = provenanceDescription },
      ) {
        // Screen name positioned 8dp above the card (plus ~12dp for text height)
        Text(
          text = screen.name.take(12) + if (screen.name.length > 12) "…" else "",
          fontSize = 9.sp,
          color = colors.text.normal.copy(alpha = textAlpha),
          modifier = Modifier.align(Alignment.TopCenter).offset(y = (-20).dp),
        )

        // Screenshot card - edge to edge
        Box(
          modifier =
            Modifier.size(NODE_WIDTH, NODE_HEIGHT)
              .clip(RoundedCornerShape(8.dp))
              .background(colors.text.normal.copy(alpha = 0.08f))
              .then(
                if (isHighlighted)
                  Modifier.border(borderWidth, borderColor, RoundedCornerShape(8.dp))
                else Modifier,
              ),
          contentAlignment = Alignment.Center,
        ) {
          when {
            screenshotBitmap != null -> {
              Image(
                bitmap = screenshotBitmap,
                contentDescription = "Screenshot of ${screen.name}",
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop,
              )
            }
            isLoadingScreenshot -> {
              // Show subtle loading indicator (dimmed placeholder)
              Box(
                modifier =
                  Modifier.fillMaxSize().background(colors.text.normal.copy(alpha = 0.04f)),
              )
            }
          // else: empty placeholder (no screenshot available)
          }
        }
      }
    }
  }
}
