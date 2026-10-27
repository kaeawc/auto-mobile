package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import dev.jasonpearson.automobile.prototype.*

/**
 * The haptics and sound modules, the clipboard, and the contract test module debug builds carry.
 */
internal fun prototypeRuntimePlatform(
  context: Context,
  clipboard: PrototypeClipboard? = null,
): PrototypePlatform =
  PrototypePlatform(
    prototypeFeedbackModules(context) +
      listOfNotNull(TestPlatformModule(), clipboard?.let { PrototypeClipboardModule(it) }),
  )
