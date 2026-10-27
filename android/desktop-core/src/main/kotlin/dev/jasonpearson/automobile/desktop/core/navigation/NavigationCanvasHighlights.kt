@file:OptIn(ExperimentalFoundationApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

@Composable
internal fun rememberCanvasHighlights(
  options: NavigationCanvasOptions,
  interaction: NavigationCanvasInteraction,
): NavigationCanvasHighlights =
  with(options) {
    with(interaction) {
      val highlightState = rememberCanvasHighlightState(options, interaction)

      // For backwards compatibility, compute combined highlighted screens
      val highlightedScreens =
        remember(highlightState) {
          buildSet {
            highlightState.hoveredScreen?.let { add(it) }
            addAll(highlightState.sourceScreens)
            addAll(highlightState.targetScreens)
            addAll(highlightState.testFlowScreens)
          }
        }

      // Compute highlighted transitions for test flow (sequential path through screens)
      val testFlowTransitions = rememberTestFlowTransitions(options, highlightState)

      val highlightedTransitions =
        rememberHighlightedTransitions(options, interaction, testFlowTransitions)

      NavigationCanvasHighlights(highlightState, highlightedScreens, highlightedTransitions)
    }
  }

@Composable
private fun rememberCanvasHighlightState(
  options: NavigationCanvasOptions,
  interaction: NavigationCanvasInteraction,
): HighlightState =
  with(options) {
    with(interaction) {
      remember(hoveredScreenName, hoveredTransitionId, transitions, externalHighlightedScreens) {
        when {
          hoveredScreenName != null -> {
            // Hovering a screen: show where we came from (sources) and where we can go (targets)
            val sources = mutableSetOf<String>()
            val targets = mutableSetOf<String>()
            transitions
              .filter { it.trigger != "back" }
              .forEach { t ->
                if (t.fromScreen == hoveredScreenName) targets.add(t.toScreen)
                if (t.toScreen == hoveredScreenName) sources.add(t.fromScreen)
              }
            HighlightState(
              hoveredScreen = hoveredScreenName,
              sourceScreens = sources,
              targetScreens = targets,
            )
          }
          hoveredTransitionId != null -> {
            // Hovering an edge: source is orange, target is green
            val transition = transitions.find { it.id == hoveredTransitionId }
            if (transition != null) {
              HighlightState(
                sourceScreens = setOf(transition.fromScreen),
                targetScreens = setOf(transition.toScreen),
              )
            } else HighlightState()
          }
          externalHighlightedScreens.isNotEmpty() -> {
            // External highlights (e.g., from "View in Graph" on test detail)
            HighlightState(testFlowScreens = externalHighlightedScreens.toSet())
          }
          else -> HighlightState()
        }
      }
    }
  }

@Composable
private fun rememberTestFlowTransitions(
  options: NavigationCanvasOptions,
  highlightState: HighlightState,
): Set<String> =
  with(options) {
    remember(highlightState.testFlowScreens, transitions) {
      if (highlightState.testFlowScreens.isEmpty()) emptySet()
      else {
        val flowScreensList = externalHighlightedScreens
        val flowTransitions = mutableSetOf<String>()
        // Find transitions between consecutive screens in the flow
        for (i in 0 until flowScreensList.size - 1) {
          val fromScreen = flowScreensList[i]
          val toScreen = flowScreensList[i + 1]
          transitions
            .find { it.fromScreen == fromScreen && it.toScreen == toScreen }
            ?.let { flowTransitions.add(it.id) }
        }
        flowTransitions
      }
    }
  }

@Composable
private fun rememberHighlightedTransitions(
  options: NavigationCanvasOptions,
  interaction: NavigationCanvasInteraction,
  testFlowTransitions: Set<String>,
): Set<String> =
  with(options) {
    with(interaction) {
      remember(hoveredScreenName, hoveredTransitionId, transitions, testFlowTransitions) {
        when {
          testFlowTransitions.isNotEmpty() -> testFlowTransitions
          hoveredScreenName != null -> {
            // Highlight all edges connected to hovered screen
            transitions
              .filter { it.trigger != "back" }
              .filter { it.fromScreen == hoveredScreenName || it.toScreen == hoveredScreenName }
              .map { it.id }
              .toSet()
          }
          hoveredTransitionId != null ->
            setOf(requireNotNull(hoveredTransitionId) { "Hovered transition must be present" })
          else -> emptySet()
        }
      }
    }
  }
