package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** Keeps IME access and view focus observable without a keyboard or Compose frame in tests. */
interface PrototypeKeyboard {
  fun hideIme(view: View)

  fun clearFocus(view: View)
}

object AndroidPrototypeKeyboard : PrototypeKeyboard {
  // Overlays have no Activity Window to pass to WindowCompat.getInsetsController.
  @Suppress("DEPRECATION")
  override fun hideIme(view: View) {
    ViewCompat.getWindowInsetsController(view)?.hide(WindowInsetsCompat.Type.ime())
  }

  override fun clearFocus(view: View) {
    view.clearFocus()
  }
}
