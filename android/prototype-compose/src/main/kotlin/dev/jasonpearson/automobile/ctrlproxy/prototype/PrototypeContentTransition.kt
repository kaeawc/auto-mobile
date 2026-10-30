package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.core.ExperimentalTransitionApi
import androidx.compose.animation.core.Transition
import androidx.compose.animation.core.createChildTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.updateTransition
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.IntOffset
import dev.jasonpearson.automobile.protocol.contentTransitionDirection

// Replace with motion tokens when available (#15243).
private const val CONTENT_FADE_MS = 200
private const val CONTENT_ROLL_DAMPING = 0.8f
private const val CONTENT_ROLL_STIFFNESS = 380f

private fun contentTransitionDisabled(mode: String?, profile: PrototypeMotionProfile): Boolean =
  mode == null || mode == "none" || profile == PrototypeMotionProfile.OFF

private fun String.characters(): List<String> =
  codePoints().toArray().map { String(Character.toChars(it)) }

/** One semantic label updates immediately; drawn outgoing characters are never accessible. */
@OptIn(ExperimentalTransitionApi::class)
@Composable
internal fun PrototypeContentTransition(
  value: AnnotatedString,
  mode: String?,
  rich: Boolean,
  modifier: Modifier,
  content: @Composable (AnnotatedString, Modifier) -> Unit,
) {
  val profile = LocalPrototypeMotionProfile.current
  if (contentTransitionDisabled(mode, profile) || !LocalPrototypeMotion.current) {
    content(value, modifier)
    return
  }
  var previous by remember { mutableStateOf(value.text) }
  val direction = remember(value.text) { contentTransitionDirection(previous, value.text) }
  SideEffect { previous = value.text }
  val transition = updateTransition(value, label = "content text")
  ReportPrototypeMotion {
    transition.isRunning || transition.currentState != transition.targetState
  }
  val roll =
    mode == "numeric" && !rich && profile == PrototypeMotionProfile.FULL && direction != "crossfade"
  val semantics = modifier.clearAndSetSemantics { text = value }
  if (roll) {
    PrototypeRollingCharacters(transition, value, direction, semantics, content)
  } else {
    transition.AnimatedContent(
      modifier = semantics,
      transitionSpec = {
        fadeIn(tween(CONTENT_FADE_MS)) togetherWith fadeOut(tween(CONTENT_FADE_MS))
      },
    ) { shown ->
      content(shown, Modifier.clearAndSetSemantics {})
    }
  }
}

/** Characters aligned from the end; only the ones that changed roll. */
@OptIn(ExperimentalTransitionApi::class)
@Composable
private fun PrototypeRollingCharacters(
  transition: Transition<AnnotatedString>,
  value: AnnotatedString,
  direction: String,
  modifier: Modifier,
  content: @Composable (AnnotatedString, Modifier) -> Unit,
) {
  val before = remember(transition.currentState.text) { transition.currentState.text.characters() }
  val after = remember(value.text) { value.text.characters() }
  Row(modifier) {
    for (position in maxOf(before.size, after.size) - 1 downTo 0) {
      key(position) {
        val character =
          transition.createChildTransition(label = "digit $position") {
            val characters = if (it.text == value.text) after else before
            characters.getOrNull(characters.lastIndex - position).orEmpty()
          }
        character.AnimatedContent(transitionSpec = { rollSpec(direction) }) { shown ->
          content(AnnotatedString(shown), Modifier.clearAndSetSemantics {})
        }
      }
    }
  }
}

private fun rollSpec(direction: String): ContentTransform {
  val sign = if (direction == "up") 1 else -1
  val spring =
    spring<IntOffset>(dampingRatio = CONTENT_ROLL_DAMPING, stiffness = CONTENT_ROLL_STIFFNESS)
  return (slideInVertically(spring) { sign * it } + fadeIn(tween(CONTENT_FADE_MS))) togetherWith
    (slideOutVertically(spring) { -sign * it } + fadeOut(tween(CONTENT_FADE_MS)))
}
