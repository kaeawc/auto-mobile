package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import dev.jasonpearson.automobile.prototype.PrototypePlatform

/** Haptics and sound need no runtime permission; no permission-needing module is registered. */
internal fun prototypeRuntimePlatform(context: Context): PrototypePlatform =
  PrototypePlatform(prototypeFeedbackModules(context))
