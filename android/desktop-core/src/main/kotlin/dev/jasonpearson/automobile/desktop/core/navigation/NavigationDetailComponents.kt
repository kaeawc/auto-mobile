package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.components.Link
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
internal fun TransitionPath(
  transition: ScreenTransition,
  currentScreen: String?,
  onScreenClick: ((String) -> Unit)?,
  triggerIcon: String,
  modifier: Modifier,
) {
  val colors = SharedTheme.globalColors
  Row(
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
    modifier = modifier,
  ) {
    Text(triggerIcon, fontSize = 12.sp)
    // From screen - only link if not current screen
    if (onScreenClick != null && transition.fromScreen != currentScreen) {
      Link(transition.fromScreen, onClick = { onScreenClick(transition.fromScreen) })
    } else {
      Text(transition.fromScreen, fontSize = 12.sp)
    }
    Text("→", fontSize = 12.sp, color = colors.text.normal.copy(alpha = 0.4f))
    // To screen - only link if not current screen
    if (onScreenClick != null && transition.toScreen != currentScreen) {
      Link(transition.toScreen, onClick = { onScreenClick(transition.toScreen) })
    } else {
      Text(transition.toScreen, fontSize = 12.sp)
    }
    transition.element?.let {
      Text(
        "($it)",
        fontSize = 11.sp,
        color = colors.text.normal.copy(alpha = 0.4f),
      )
    }
  }
}

@Composable
internal fun TransitionStatistics(transition: ScreenTransition) {
  val colors = SharedTheme.globalColors
  Row(
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    // Show traversal count (or latency if available)
    if (transition.avgLatencyMs > 0) {
      Text(
        "${transition.avgLatencyMs}ms",
        fontSize = 11.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
      )
    } else {
      Text(
        "${transition.traversalCount}x",
        fontSize = 11.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
      )
    }
    if (transition.failureRate > 0) {
      Text(
        "${(transition.failureRate * 100).toInt()}% fail",
        fontSize = 10.sp,
        color = Color(0xFFFF5722).copy(alpha = 0.8f),
      )
    }
  }
}

@Composable
internal fun ScreenScreenshot(
  screen: ScreenNode,
  screenshotLoader: ScreenshotLoader?,
  ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
  // Screenshot loading state
  var screenshotBitmap by remember { mutableStateOf<ImageBitmap?>(null) }
  var isLoadingScreenshot by remember { mutableStateOf(false) }

  val screenshotUri = screen.screenshotUri
  LaunchedEffect(screenshotUri, screenshotLoader) {
    if (screenshotUri != null && screenshotLoader != null) {
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

  ScreenshotImage(screen.name, screenshotBitmap, isLoadingScreenshot)
}

@Composable
internal fun ScreenHeading(screen: ScreenNode) {
  val colors = SharedTheme.globalColors
  // Header
  Row(
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(screen.name, fontSize = 16.sp)
    Text(
      screen.type,
      fontSize = 11.sp,
      color = colors.text.normal.copy(alpha = 0.6f),
      modifier =
        Modifier.background(colors.text.normal.copy(alpha = 0.1f), RoundedCornerShape(4.dp))
          .padding(horizontal = 6.dp, vertical = 2.dp),
    )
  }
  Text(
    screen.packageName,
    fontSize = 12.sp,
    color = colors.text.normal.copy(alpha = 0.5f),
    modifier = Modifier.padding(top = 2.dp),
  )
}

@Composable
internal fun ScreenTransitionList(
  title: String,
  transitions: List<ScreenTransition>,
  currentScreen: String,
  onScreenSelected: (String) -> Unit,
) {
  val colors = SharedTheme.globalColors
  if (transitions.isEmpty()) return
  Text(title, fontSize = 13.sp, color = colors.text.normal.copy(alpha = 0.8f))
  Spacer(Modifier.height(8.dp))
  transitions.forEach { transition ->
    TransitionRow(
      transition = transition,
      onClick = {},
      currentScreen = currentScreen,
      onScreenClick = onScreenSelected,
    )
    Spacer(Modifier.height(4.dp))
  }
}

@Composable
private fun ScreenshotImage(
  screenName: String,
  screenshotBitmap: ImageBitmap?,
  isLoadingScreenshot: Boolean,
) {
  val colors = SharedTheme.globalColors
  // Screenshot
  Box(
    modifier =
      Modifier.width(120.dp)
        .height(220.dp)
        .clip(RoundedCornerShape(8.dp))
        .background(colors.text.normal.copy(alpha = 0.08f)),
    contentAlignment = Alignment.Center,
  ) {
    when {
      screenshotBitmap != null -> {
        Image(
          bitmap =
            requireNotNull(screenshotBitmap) { "Screenshot must be loaded before rendering" },
          contentDescription = "Screenshot of ${screenName}",
          modifier = Modifier.fillMaxSize(),
          contentScale = ContentScale.Crop,
        )
      }
      isLoadingScreenshot -> {
        Text("Loading...", fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.3f))
      }
      else -> {
        Text("No screenshot", fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.3f))
      }
    }
  }
}
