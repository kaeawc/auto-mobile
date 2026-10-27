package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.ContentResolver
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember

/** Spatial animations require FULL; fades and colors also run under REDUCED. */
internal enum class PrototypeMotionProfile {
  FULL,
  REDUCED,
  OFF,
}

internal val LocalPrototypeMotionProfile = compositionLocalOf { PrototypeMotionProfile.OFF }

internal fun prototypeMotionProfile(
  motion: String?,
  animatorScale: Float,
  transitionScale: Float,
): PrototypeMotionProfile =
  when {
    motion == "none" || animatorScale == 0f || transitionScale == 0f -> PrototypeMotionProfile.OFF
    motion == "reduced" -> PrototypeMotionProfile.REDUCED
    else -> PrototypeMotionProfile.FULL
  }

/** Compatibility for callers that only supply the animator scale. */
internal fun prototypeMotionEnabled(motion: String?, durationScale: Float): Boolean =
  prototypeMotionProfile(motion, durationScale, 1f) != PrototypeMotionProfile.OFF

/** Reads the system animator duration scale; 1 (the platform default) when unset. */
internal fun readAnimatorDurationScale(resolver: ContentResolver): Float =
  Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)

@Composable
internal fun rememberAnimatorDurationScale(resolver: ContentResolver): State<Float> =
  rememberPrototypeAnimationScale(resolver, Settings.Global.ANIMATOR_DURATION_SCALE)

@Composable
internal fun rememberTransitionAnimationScale(resolver: ContentResolver): State<Float> =
  rememberPrototypeAnimationScale(resolver, Settings.Global.TRANSITION_ANIMATION_SCALE)

/** Observe each setting and close the read/registration race while the root is composed. */
@Composable
private fun rememberPrototypeAnimationScale(
  resolver: ContentResolver,
  setting: String,
): State<Float> {
  val scale =
    remember(resolver, setting) {
      mutableFloatStateOf(Settings.Global.getFloat(resolver, setting, 1f))
    }
  DisposableEffect(resolver, setting) {
    val observer =
      object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) {
          scale.floatValue = Settings.Global.getFloat(resolver, setting, 1f)
        }
      }
    resolver.registerContentObserver(Settings.Global.getUriFor(setting), false, observer)
    scale.floatValue = Settings.Global.getFloat(resolver, setting, 1f)
    onDispose { resolver.unregisterContentObserver(observer) }
  }
  return scale
}

/** Explicit none stays instant; reduced spatial transitions crossfade. */
internal fun prototypeVisibilityTransition(
  type: String?,
  profile: PrototypeMotionProfile,
  shared: Boolean = false,
): String? =
  if (profile == PrototypeMotionProfile.REDUCED && (type != "none" || shared)) "fade" else type
