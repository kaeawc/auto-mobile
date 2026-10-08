package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.content.ContentResolver
import android.provider.Settings
import androidx.compose.runtime.compositionLocalOf

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
