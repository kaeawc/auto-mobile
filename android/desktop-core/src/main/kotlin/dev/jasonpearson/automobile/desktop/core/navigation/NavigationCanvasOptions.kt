@file:OptIn(ExperimentalFoundationApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
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
  val ioDispatcher: kotlinx.coroutines.CoroutineDispatcher = kotlinx.coroutines.Dispatchers.IO,
)
