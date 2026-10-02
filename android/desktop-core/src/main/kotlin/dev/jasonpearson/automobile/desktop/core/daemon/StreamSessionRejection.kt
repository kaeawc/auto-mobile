package dev.jasonpearson.automobile.desktop.core.daemon

internal fun isStreamSessionRejection(error: String?): Boolean =
  error?.let {
    it.contains("requires an authenticated daemon session") ||
      it.contains("not an active daemon session") ||
      it.contains("daemon/registerSession")
  } == true

internal class StreamSessionRejectedException(message: String) : IllegalStateException(message)
