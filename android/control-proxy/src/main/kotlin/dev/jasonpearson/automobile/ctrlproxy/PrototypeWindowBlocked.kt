package dev.jasonpearson.automobile.ctrlproxy

import android.app.KeyguardManager
import android.content.Context
import android.os.PowerManager

/**
 * Whether a prototype window must stay hidden: the device is locked or its screen is off. A state
 * that cannot be read counts as blocked, so a prototype is never drawn over a lock screen by guess.
 */
internal fun prototypeWindowBlocked(keyguardLocked: Boolean?, interactive: Boolean?): Boolean =
  keyguardLocked != false || interactive != true

/** [prototypeWindowBlocked] for this device's current keyguard and power state. */
internal fun Context.prototypeWindowBlocked(): Boolean =
  prototypeWindowBlocked(
    keyguardLocked =
      (getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)?.isKeyguardLocked,
    interactive = (getSystemService(Context.POWER_SERVICE) as? PowerManager)?.isInteractive,
  )
