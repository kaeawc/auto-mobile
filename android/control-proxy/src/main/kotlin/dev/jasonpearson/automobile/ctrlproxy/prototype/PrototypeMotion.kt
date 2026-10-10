package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.ContentResolver
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.expandIn
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer

/**
 * Whether prototype state changes (visibility, page) animate. Off by default so previews and direct
 * [PrototypeSpecContent] callers stay settled; [PrototypeRuntimeContent] turns it on from the spec.
 */
internal val LocalPrototypeMotion = compositionLocalOf { false }

/**
 * Animation is on unless the spec opts out (`motion: "none"`) or the system animator duration scale
 * is 0 (`settings put global animator_duration_scale 0`), which keeps screenshots settled.
 */
internal fun prototypeMotionEnabled(motion: String?, durationScale: Float): Boolean =
  motion != "none" && durationScale > 0f

/** Reads the system animator duration scale; 1 (the platform default) when unset. */
internal fun readAnimatorDurationScale(resolver: ContentResolver): Float =
  Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)

/**
 * The system animator duration scale as Compose state, kept current while the prototype is shown.
 * Automation commonly sets the scale to 0 after a prototype is already up; observing the setting
 * (rather than reading it once per spec) makes the very next state change instant, so `observe`
 * never captures an in-flight animation.
 */
@Composable
internal fun rememberAnimatorDurationScale(resolver: ContentResolver): State<Float> {
  val scale = remember(resolver) { mutableFloatStateOf(readAnimatorDurationScale(resolver)) }
  DisposableEffect(resolver) {
    val observer =
      object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) {
          scale.floatValue = readAnimatorDurationScale(resolver)
        }
      }
    resolver.registerContentObserver(
      Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE),
      false,
      observer,
    )
    // A change between the first read and registration has no callback; re-read once.
    scale.floatValue = readAnimatorDurationScale(resolver)
    onDispose { resolver.unregisterContentObserver(observer) }
  }
  return scale
}

/** The `visibleWhen` enter transition for a node's `transition`; absent keeps fade + expand. */
internal fun prototypeEnterTransition(transition: String?): EnterTransition =
  when (transition) {
    "none" -> EnterTransition.None
    "fade" -> fadeIn()
    "expand" -> expandIn()
    "slide" -> slideInVertically() + fadeIn()
    else -> fadeIn() + expandIn()
  }

/** The `visibleWhen` exit transition for a node's `transition`; absent keeps fade + shrink. */
internal fun prototypeExitTransition(transition: String?): ExitTransition =
  when (transition) {
    "none" -> ExitTransition.None
    "fade" -> fadeOut()
    "expand" -> shrinkOut()
    "slide" -> slideOutVertically() + fadeOut()
    else -> fadeOut() + shrinkOut()
  }

/**
 * Animates a container's size as its children appear, disappear or change; unchanged when motion is
 * off so settled screenshots never see an in-flight size.
 */
internal fun Modifier.prototypeAnimateSize(enabled: Boolean): Modifier =
  if (enabled) animateContentSize() else this

/**
 * Scales a node to [scale] while [source] reports a press. The scale animates with a spring when
 * motion is on and snaps otherwise (`motion: "none"` or animator duration scale 0), so a press held
 * for a screenshot is deterministic.
 */
@Composable
internal fun Modifier.prototypePressScale(source: InteractionSource, scale: Float): Modifier {
  val pressed by source.collectIsPressedAsState()
  val spec = if (LocalPrototypeMotion.current) spring<Float>() else snap()
  val current by
    animateFloatAsState(if (pressed) scale else 1f, spec, label = "prototypePressScale")
  return graphicsLayer {
    scaleX = current
    scaleY = current
  }
}
