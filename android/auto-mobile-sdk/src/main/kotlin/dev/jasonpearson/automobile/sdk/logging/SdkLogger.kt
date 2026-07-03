package dev.jasonpearson.automobile.sdk.logging

import android.util.Log

/**
 * Internal structured logger for SDK diagnostics.
 *
 * Uses lazy message builders `(() -> String)` so that string concatenation is avoided entirely when
 * a particular log level is disabled or the logger is a no-op (e.g. [NoOpSdkLogger]).
 */
internal interface SdkLogger {
  fun d(tag: String, msg: () -> String)

  fun i(tag: String, msg: () -> String)

  fun w(tag: String, tr: Throwable? = null, msg: () -> String)

  fun e(tag: String, tr: Throwable? = null, msg: () -> String)
}

/** Default implementation that delegates to [android.util.Log]. */
internal class DefaultSdkLogger : SdkLogger {
  override fun d(tag: String, msg: () -> String) {
    Log.d(tag, msg())
  }

  override fun i(tag: String, msg: () -> String) {
    Log.i(tag, msg())
  }

  override fun w(tag: String, tr: Throwable?, msg: () -> String) {
    if (tr != null) Log.w(tag, msg(), tr) else Log.w(tag, msg())
  }

  override fun e(tag: String, tr: Throwable?, msg: () -> String) {
    if (tr != null) Log.e(tag, msg(), tr) else Log.e(tag, msg())
  }
}

/** Silent logger that discards all messages. */
internal object NoOpSdkLogger : SdkLogger {
  override fun d(tag: String, msg: () -> String) = Unit

  override fun i(tag: String, msg: () -> String) = Unit

  override fun w(tag: String, tr: Throwable?, msg: () -> String) = Unit

  override fun e(tag: String, tr: Throwable?, msg: () -> String) = Unit
}
