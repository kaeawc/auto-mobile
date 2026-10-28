package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import android.content.res.Configuration
import android.hardware.display.DisplayManager
import android.view.Display

/** Null means the host cannot determine the shape of this logical display. */
internal fun interface PrototypeScreenShapeSource {
  fun screenRound(displayId: Int): Boolean?
}

/** Configuration.isScreenRound is available from API 23; CtrlProxy's minSdk is 24. */
internal class AndroidPrototypeScreenShapeSource(private val context: Context) :
  PrototypeScreenShapeSource {
  override fun screenRound(displayId: Int): Boolean? {
    val target =
      if (displayId == Display.DEFAULT_DISPLAY) context
      else {
        val display =
          (context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager)?.getDisplay(
            displayId,
          ) ?: return null
        context.createDisplayContext(display)
      }
    val configuration = target.resources.configuration
    if (
      configuration.screenLayout and Configuration.SCREENLAYOUT_ROUND_MASK ==
        Configuration.SCREENLAYOUT_ROUND_UNDEFINED
    )
      return null
    return configuration.isScreenRound
  }
}
