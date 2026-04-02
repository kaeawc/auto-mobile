package dev.jasonpearson.automobile.sdk.logging

import android.util.Log

/**
 * Thin wrapper around [android.util.Log].
 *
 * Log capture is now handled by the logcat reader in CtrlProxy,
 * so this class simply delegates to the platform Log API.
 */
object AutoMobileLog {

  /** No-op retained for source compatibility during migration. */
  internal fun initialize() {
  }

  fun v(tag: String, msg: String): Int = Log.v(tag, msg)

  fun v(tag: String, msg: String, tr: Throwable): Int = Log.v(tag, msg, tr)

  fun d(tag: String, msg: String): Int = Log.d(tag, msg)

  fun d(tag: String, msg: String, tr: Throwable): Int = Log.d(tag, msg, tr)

  fun i(tag: String, msg: String): Int = Log.i(tag, msg)

  fun i(tag: String, msg: String, tr: Throwable): Int = Log.i(tag, msg, tr)

  fun w(tag: String, msg: String): Int = Log.w(tag, msg)

  fun w(tag: String, msg: String, tr: Throwable): Int = Log.w(tag, msg, tr)

  fun e(tag: String, msg: String): Int = Log.e(tag, msg)

  fun e(tag: String, msg: String, tr: Throwable): Int = Log.e(tag, msg, tr)

  fun wtf(tag: String, msg: String): Int {
    Log.wtf(tag, msg)
    return 0
  }

  fun wtf(tag: String, msg: String, tr: Throwable): Int {
    Log.wtf(tag, msg, tr)
    return 0
  }
}
