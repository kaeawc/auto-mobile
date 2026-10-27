package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.ExperimentalTransitionApi
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
import dev.jasonpearson.automobile.protocol.contentTransitionDirection

// Replace with motion tokens when available (#15243).
private const val CONTENT_FADE_MS = 200
private const val CONTENT_ROLL_DAMPING = 0.8f
private const val CONTENT_ROLL_STIFFNESS = 380f

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
  if (
    mode == null ||
      mode == "none" ||
      !LocalPrototypeMotion.current ||
      profile == PrototypeMotionProfile.OFF
  ) {
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
    val before =
      remember(transition.currentState.text) {
        transition.currentState.text.codePoints().toArray().map { String(Character.toChars(it)) }
      }
    val after =
      remember(value.text) {
        value.text.codePoints().toArray().map { String(Character.toChars(it)) }
      }
    Row(semantics) {
      val count = maxOf(before.size, after.size)
      for (position in count - 1 downTo 0) {
        key(position) {
          val character =
            transition.createChildTransition(label = "digit $position") {
              val characters = if (it.text == value.text) after else before
              characters.getOrNull(characters.lastIndex - position).orEmpty()
            }
          character.AnimatedContent(
            transitionSpec = {
              val sign = if (direction == "up") 1 else -1
              (slideInVertically(
                spring(dampingRatio = CONTENT_ROLL_DAMPING, stiffness = CONTENT_ROLL_STIFFNESS),
              ) {
                sign * it
              } + fadeIn(tween(CONTENT_FADE_MS))) togetherWith
                (slideOutVertically(
                  spring(dampingRatio = CONTENT_ROLL_DAMPING, stiffness = CONTENT_ROLL_STIFFNESS),
                ) {
                  -sign * it
                } + fadeOut(tween(CONTENT_FADE_MS)))
            },
          ) { shown ->
            content(AnnotatedString(shown), Modifier.clearAndSetSemantics {})
          }
        }
      }
    }
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
