package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.prototype.*

internal fun prototypeRuntimePlatform(clipboard: PrototypeClipboard? = null): PrototypePlatform =
  PrototypePlatform(listOfNotNull(clipboard?.let { PrototypeClipboardModule(it) }))
