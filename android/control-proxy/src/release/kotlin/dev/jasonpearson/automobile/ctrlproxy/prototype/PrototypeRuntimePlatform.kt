package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import dev.jasonpearson.automobile.prototype.*

/** Haptics, sound and the clipboard need no runtime permission the overlay would have to request. */
internal fun prototypeRuntimePlatform(
  context: Context,
  clipboard: PrototypeClipboard? = null,
): PrototypePlatform =
  PrototypePlatform(
    prototypeFeedbackModules(context) + listOfNotNull(clipboard?.let { PrototypeClipboardModule(it) }),
  )
