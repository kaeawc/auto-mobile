@file:OptIn(ExperimentalFoundationApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.time.Clock
import dev.jasonpearson.automobile.desktop.core.time.SystemClock
import kotlinx.coroutines.Dispatchers

data class NavigationCanvasOptions(
  val screens: List<ScreenNode>,
  val transitions: List<ScreenTransition>,
  val onScreenSelected: (String) -> Unit,
  val externalHighlightedScreens: List<String> = emptyList(),
  val currentReplayScreen: String? = null,
  val screenshotLoader: ScreenshotLoader? = null,
  val fogModeEnabled: Boolean = true,
  val currentObservedScreen: String? = null,
  val onFogModeToggled: (Boolean) -> Unit = {},
  val fitToViewTrigger: Int = 0,
  val activeContext: NavigationActiveContext? = null,
  // Build lens over the union graph (#4987); [BuildLens.Union] keeps Phase 2 opacity.
  val buildLens: BuildLens = BuildLens.Union,
  // Per-build labels (`branch@shortsha` when declared, #16954) for accessible descriptions.
  val buildLabels: Map<ProvenanceBuildKey, String> = emptyMap(),
  // Time source for the recency-graded fade (#16952); tests inject a FakeClock.
  val clock: Clock = SystemClock,
  val ioDispatcher: kotlinx.coroutines.CoroutineDispatcher = kotlinx.coroutines.Dispatchers.IO,
)
