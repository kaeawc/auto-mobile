package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import dev.jasonpearson.automobile.prototype.PrototypePlatform

/** The haptics and sound modules, plus the contract test module that debug builds carry. */
internal fun prototypeRuntimePlatform(context: Context): PrototypePlatform =
  PrototypePlatform(
    prototypeFeedbackModules(context) + dev.jasonpearson.automobile.prototype.TestPlatformModule(),
  )
