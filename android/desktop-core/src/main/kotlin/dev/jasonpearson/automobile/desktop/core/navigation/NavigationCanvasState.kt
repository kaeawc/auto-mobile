@file:OptIn(ExperimentalFoundationApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color

internal data class HighlightState(
  val hoveredScreen: String? = null,
  val sourceScreens: Set<String> = emptySet(), // Orange - nodes we came from
  val targetScreens: Set<String> = emptySet(), // Green - nodes we could go to
  val testFlowScreens: Set<String> = emptySet(), // Blue - screens from test flow
)

internal data class EdgeHitZone(
  val transitionId: String,
  val startX: Float,
  val startY: Float,
  val endX: Float,
  val endY: Float,
)

internal class NavigationCanvasInteraction {
  var scale by mutableFloatStateOf(1f)
  var offsetX by mutableFloatStateOf(0f)
  var offsetY by mutableFloatStateOf(0f)
  var hoveredScreenName by mutableStateOf<String?>(null)
  var hoveredTransitionId by mutableStateOf<String?>(null)
  var mouseX by mutableFloatStateOf(0f)
  var mouseY by mutableFloatStateOf(0f)
  var focusedScreenName by mutableStateOf<String?>(null)
  var hasInitialFit by mutableStateOf(false)
  var lastAutoPannedScreens by mutableStateOf<List<String>>(emptyList())
  val animatedOffsetX = Animatable(0f)
  val animatedOffsetY = Animatable(0f)
  val animatedScale = Animatable(1f)
}

internal data class NavigationCanvasLayout(
  val density: androidx.compose.ui.unit.Density,
  val nodePositions: List<NodePosition>,
  val screenById: Map<String, ScreenNode>,
  val screenByName: Map<String, ScreenNode>,
  val positionByName: Map<String, NodePosition>,
  val nodeWidthPx: Float,
  val nodeHeightPx: Float,
  val edgeHitZones: List<EdgeHitZone>,
)

internal data class NavigationCanvasHighlights(
  val highlightState: HighlightState,
  val highlightedScreens: Set<String>,
  val highlightedTransitions: Set<String>,
)

internal class NavigationCanvasContext(
  val options: NavigationCanvasOptions,
  private val interaction: NavigationCanvasInteraction,
  private val layout: NavigationCanvasLayout,
  private val highlights: NavigationCanvasHighlights,
  val animationScope: kotlinx.coroutines.CoroutineScope,
  val colors: dev.jasonpearson.automobile.desktop.core.theme.SharedGlobalColors,
) {
  var scale: Float
    get() = interaction.scale
    set(value) {
      interaction.scale = value
    }

  var offsetX: Float
    get() = interaction.offsetX
    set(value) {
      interaction.offsetX = value
    }

  var offsetY: Float
    get() = interaction.offsetY
    set(value) {
      interaction.offsetY = value
    }

  var hoveredScreenName: String?
    get() = interaction.hoveredScreenName
    set(value) {
      interaction.hoveredScreenName = value
    }

  var hoveredTransitionId: String?
    get() = interaction.hoveredTransitionId
    set(value) {
      interaction.hoveredTransitionId = value
    }

  var mouseX: Float
    get() = interaction.mouseX
    set(value) {
      interaction.mouseX = value
    }

  var mouseY: Float
    get() = interaction.mouseY
    set(value) {
      interaction.mouseY = value
    }

  var focusedScreenName: String?
    get() = interaction.focusedScreenName
    set(value) {
      interaction.focusedScreenName = value
    }

  var hasInitialFit: Boolean
    get() = interaction.hasInitialFit
    set(value) {
      interaction.hasInitialFit = value
    }

  var lastAutoPannedScreens: List<String>
    get() = interaction.lastAutoPannedScreens
    set(value) {
      interaction.lastAutoPannedScreens = value
    }

  val animatedOffsetX
    get() = interaction.animatedOffsetX

  val animatedOffsetY
    get() = interaction.animatedOffsetY

  val animatedScale
    get() = interaction.animatedScale

  val density
    get() = layout.density

  val nodePositions
    get() = layout.nodePositions

  val screenById
    get() = layout.screenById

  val screenByName
    get() = layout.screenByName

  val positionByName
    get() = layout.positionByName

  val nodeWidthPx
    get() = layout.nodeWidthPx

  val nodeHeightPx
    get() = layout.nodeHeightPx

  val edgeHitZones
    get() = layout.edgeHitZones

  val highlightState
    get() = highlights.highlightState

  val highlightedScreens
    get() = highlights.highlightedScreens

  val highlightedTransitions
    get() = highlights.highlightedTransitions

  val screens
    get() = options.screens

  val transitions
    get() = options.transitions

  val onScreenSelected
    get() = options.onScreenSelected

  val externalHighlightedScreens
    get() = options.externalHighlightedScreens

  val currentReplayScreen
    get() = options.currentReplayScreen

  val screenshotLoader
    get() = options.screenshotLoader

  val fogModeEnabled
    get() = options.fogModeEnabled

  val currentObservedScreen
    get() = options.currentObservedScreen

  val onFogModeToggled
    get() = options.onFogModeToggled

  val fitToViewTrigger
    get() = options.fitToViewTrigger

  val activeContext
    get() = options.activeContext

  val ioDispatcher
    get() = options.ioDispatcher

  val arrowColor
    get() = colors.text.normal.copy(alpha = 0.3f)

  val highlightedArrowColor
    get() = Color(0xFF1976D2)

  val dimmedArrowColor
    get() = colors.text.normal.copy(alpha = 0.1f)
}
