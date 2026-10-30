package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import dev.jasonpearson.automobile.prototype.*

/**
 * Haptics, sound, the clipboard, connectivity and outbound links need no runtime permission the
 * overlay would have to request.
 */
internal fun prototypeRuntimePlatform(
  context: Context,
  clipboard: PrototypeClipboard? = null,
): PrototypePlatform =
  PrototypePlatform(
    prototypeFeedbackModules(context) +
      listOfNotNull(clipboard?.let { PrototypeClipboardModule(it) }) +
      PrototypeConnectivityModule(AndroidConnectivitySource(context)) +
      PrototypeLinksModule(AndroidUrlOpener(SystemLinkGateway(context))),
  )
