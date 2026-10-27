package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.core.*
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext

internal val LocalPrototypeWindowRetainsContent = compositionLocalOf { false }

@InternalAutoMobilePrototypeApi
data class PrototypeWindowMotionSpec(
  val transition: String,
  val placement: String,
  val edge: String = "bottom",
  val motion: String? = null,
  val animateEnter: Boolean = true,
)

/** Root-content animation, independent of platform window animation resources. */
@InternalAutoMobilePrototypeApi
@Composable
fun PrototypeWindowMotion(
  visible: Boolean,
  spec: PrototypeWindowMotionSpec,
  activity: PrototypeMotionActivity?,
  content: @Composable () -> Unit,
) {
  val resolver = LocalContext.current.contentResolver
  val animator by rememberAnimatorDurationScale(resolver)
  val systemTransition by rememberTransitionAnimationScale(resolver)
  val profile = prototypeMotionProfile(spec.motion, animator, systemTransition)
  val type = prototypeWindowTransition(spec.transition, spec.placement, profile)
  if (type == "none") {
    if (visible) content()
    return
  }
  val state = remember { MutableTransitionState(!spec.animateEnter && visible) }
  state.targetState = visible
  val animation = rememberTransition(state, label = "prototypeWindow")
  val progress by
    animation.animateFloat(transitionSpec = { tween(300) }, label = "windowProgress") {
      if (it) 1f else 0f
    }
  CompositionLocalProvider(
    LocalPrototypeMotionActivity provides activity,
    LocalPrototypeWindowRetainsContent provides true,
  ) {
    ReportPrototypeMotion { !state.isIdle }
    Box(Modifier.windowProgress(progress, type, spec.edge, prototypeRtl())) { content() }
  }
}

private fun Modifier.windowProgress(progress: Float, type: String, edge: String, rtl: Boolean) =
  graphicsLayer {
    alpha = progress
    if (type == "scale") {
      scaleX = 0.92f + 0.08f * progress
      scaleY = scaleX
    }
    if (type == "slide") {
      val sign = if (edge == "top" || edge == "start") -1 else 1
      if (edge == "start" || edge == "end")
        translationX = sign * (if (rtl) -1 else 1) * size.width * (1f - progress)
      else translationY = sign * size.height * (1f - progress)
    }
  }

internal fun prototypeWindowTransition(
  transition: String,
  placement: String,
  profile: PrototypeMotionProfile,
): String =
  when {
    profile == PrototypeMotionProfile.OFF || transition == "none" -> "none"
    profile == PrototypeMotionProfile.REDUCED -> "fade"
    transition != "auto" -> transition
    placement == "sheet" -> "slide"
    placement == "floating" -> "scale"
    else -> "fade"
  }
