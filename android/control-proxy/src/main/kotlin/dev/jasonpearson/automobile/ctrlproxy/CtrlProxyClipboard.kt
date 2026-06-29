package dev.jasonpearson.automobile.ctrlproxy

import android.content.ClipData
import android.os.Build

object CtrlProxyClipboard {
  private const val RESTRICTED_READ_ERROR =
      "Clipboard read is restricted while CtrlProxy is not foreground. " +
          "Android 10+ only allows clipboard reads from the foreground app, default IME, " +
          "or system services."

  data class ReadResult(val success: Boolean, val text: String?, val error: String?)

  fun readResultFromPrimaryClip(clip: ClipData?, sdkInt: Int = Build.VERSION.SDK_INT): ReadResult {
    if (clip == null) {
      return if (sdkInt >= Build.VERSION_CODES.Q) {
        ReadResult(success = false, text = null, error = RESTRICTED_READ_ERROR)
      } else {
        ReadResult(success = true, text = "", error = null)
      }
    }

    return ReadResult(success = true, text = clip.getItemAt(0)?.text?.toString() ?: "", error = null)
  }
}
