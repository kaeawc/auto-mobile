package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.annotation.SuppressLint
import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.Outline
import android.graphics.drawable.GradientDrawable
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import androidx.compose.foundation.shape.CornerSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.unit.Density

/** The platform window behind a floating card, with the same lifetime as its Compose view. */
interface PrototypeCardBlurWindow {
  val decor: View

  fun update(params: WindowManager.LayoutParams)

  fun remove()
}

data class PrototypeCardBlur(val radiusPx: Int, val corner: CornerSize, val density: Float) {
  fun cornerRadiusPx(width: Int, height: Int): Float =
    corner
      .toPx(Size(width.toFloat(), height.toFloat()), Density(density))
      .coerceAtMost(minOf(width, height) / 2f)
}

fun interface PrototypeCardBlurHost {
  /** A failed attach must release the view and any partially attached window before throwing. */
  fun attach(
    context: Context,
    view: View,
    params: WindowManager.LayoutParams,
    blur: PrototypeCardBlur,
  ): PrototypeCardBlurWindow
}

internal fun PrototypeRequest.floatingCardBlur(density: Float, sdkInt: Int): PrototypeCardBlur? {
  val radius = backdropBlurPx(this, density)
  if (
    placement !is PrototypePlacement.Floating ||
      sdkInt < PrototypeBackdrops.MIN_BLUR_SDK ||
      radius <= 0
  )
    return null
  val corner =
    when (val shape = backdropShape) {
      RectangleShape -> CornerSize(0)
      is RoundedCornerShape ->
        shape.topStart.takeIf {
          it == shape.topEnd && it == shape.bottomStart && it == shape.bottomEnd
        }
      else -> null
    }
  return corner?.let { PrototypeCardBlur(radius, it, density) }
}

internal object AndroidPrototypeCardBlurHost : PrototypeCardBlurHost {
  @SuppressLint("NewApi") // Callers gate on PrototypeBackdrops.MIN_BLUR_SDK.
  override fun attach(
    context: Context,
    view: View,
    params: WindowManager.LayoutParams,
    blur: PrototypeCardBlur,
  ): PrototypeCardBlurWindow {
    val manager = checkNotNull(context.getSystemService(WindowManager::class.java))
    check(manager.isCrossWindowBlurEnabled) { "Cross-window blur is disabled" }
    val dialog =
      object : Dialog(context, android.R.style.Theme_Translucent_NoTitleBar) {
        override fun dispatchKeyEvent(event: KeyEvent): Boolean =
          (event.keyCode == KeyEvent.KEYCODE_BACK && view.dispatchKeyEvent(event)) ||
            super.dispatchKeyEvent(event)
      }
    val window = checkNotNull(dialog.window)
    val attached = DialogBlurWindow(dialog, window)
    try {
      // Back belongs to the prototype view and its registered callback.
      dialog.setCancelable(false)
      dialog.setContentView(view)
      window.setBackgroundDrawable(
        object : GradientDrawable() {
          init {
            setColor(Color.TRANSPARENT)
          }

          override fun getOutline(outline: Outline) {
            outline.setRoundRect(bounds, blur.cornerRadiusPx(bounds.width(), bounds.height()))
          }
        },
      )
      attached.decor.setPadding(0, 0, 0, 0)
      window.attributes = params
      window.setDecorFitsSystemWindows(false)
      window.setBackgroundBlurRadius(blur.radiusPx)
      dialog.show()
      check(manager.isCrossWindowBlurEnabled) { "Cross-window blur was disabled during attach" }
      return attached
    } catch (@Suppress("TooGenericExceptionCaught") error: RuntimeException) {
      try {
        if (dialog.isShowing) dialog.dismiss()
        else if (attached.decor.parent != null)
          window.windowManager.removeViewImmediate(attached.decor)
      } catch (@Suppress("TooGenericExceptionCaught") cleanup: RuntimeException) {
        error.addSuppressed(cleanup)
      } finally {
        runCatching { (view.parent as? ViewGroup)?.removeView(view) }
          .onFailure(error::addSuppressed)
      }
      throw error
    }
  }

  private class DialogBlurWindow(private val dialog: Dialog, private val window: Window) :
    PrototypeCardBlurWindow {
    override val decor: View
      get() = window.decorView

    override fun update(params: WindowManager.LayoutParams) {
      require(decor.parent != null) { "Prototype card window is detached" }
      window.attributes = params
    }

    override fun remove() {
      dialog.dismiss()
    }
  }
}
