@file:OptIn(ExperimentalFoundationApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import kotlinx.coroutines.Dispatchers

data class ScreenNodeCardOptions(
  val screen: ScreenNode,
  val isHovered: Boolean,
  val isSource: Boolean,
  val isTarget: Boolean,
  val isInTestFlow: Boolean = false,
  val isCurrentReplayStep: Boolean = false,
  val isFogFocused: Boolean = false,
  val isDimmed: Boolean,
  val provenanceAlpha: Float = ProvenanceOpacity.ACTIVE_ALPHA,
  val provenanceDescription: String = "",
  val onClick: () -> Unit,
  val onHoverChange: (Boolean) -> Unit,
  val screenshotLoader: ScreenshotLoader? = null,
  val ioDispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.IO,
)
