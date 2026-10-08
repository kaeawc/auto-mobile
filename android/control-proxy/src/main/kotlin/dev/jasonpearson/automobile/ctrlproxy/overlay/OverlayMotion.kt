package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.content.ContentResolver
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.expandIn
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier

/**
 * Whether overlay state changes (visibility, page) animate. Off by default so previews and direct
 * [OverlaySpecContent] callers stay settled; [OverlayRuntimeContent] turns it on from the spec.
 */
internal val LocalOverlayMotion = compositionLocalOf { false }

/**
 * Animation is on unless the spec opts out (`motion: "none"`) or the system animator duration scale
 * is 0 (`settings put global animator_duration_scale 0`), which keeps screenshots settled.
 */
internal fun overlayMotionEnabled(motion: String?, durationScale: Float): Boolean =
  motion != "none" && durationScale > 0f

/** Reads the system animator duration scale; 1 (the platform default) when unset. */
internal fun readAnimatorDurationScale(resolver: ContentResolver): Float =
  Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)

/**
 * The system animator duration scale as Compose state, kept current while the overlay is shown.
 * Automation commonly sets the scale to 0 after an overlay is already up; observing the setting
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
internal fun overlayEnterTransition(transition: String?): EnterTransition =
  when (transition) {
    "none" -> EnterTransition.None
    "fade" -> fadeIn()
    "expand" -> expandIn()
    "slide" -> slideInVertically() + fadeIn()
    else -> fadeIn() + expandIn()
  }

/** The `visibleWhen` exit transition for a node's `transition`; absent keeps fade + shrink. */
internal fun overlayExitTransition(transition: String?): ExitTransition =
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
internal fun Modifier.overlayAnimateSize(enabled: Boolean): Modifier =
  if (enabled) animateContentSize() else this
