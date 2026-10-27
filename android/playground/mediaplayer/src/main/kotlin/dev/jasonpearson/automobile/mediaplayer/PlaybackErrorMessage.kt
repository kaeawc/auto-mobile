package dev.jasonpearson.automobile.mediaplayer

import android.util.Log
import androidx.media3.common.PlaybackException

/** Handle playback errors and provide user-friendly messages. */
internal fun playbackErrorMessage(error: PlaybackException): String {
  Log.e("MediaPlayerVM", "Detailed error: ${error.errorCodeName}, cause: ${error.cause?.message}")

  val errorMessage =
    when (error.errorCode) {
      PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED -> {
        "Network connection failed. Please check your internet connection."
      }

      PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND -> {
        "Media file not found. The content may have been moved or deleted."
      }

      PlaybackException.ERROR_CODE_DECODER_INIT_FAILED -> {
        if (
          error.cause?.message?.contains("vp9", ignoreCase = true) == true ||
            error.cause?.message?.contains("webm", ignoreCase = true) == true
        ) {
          "This video codec (WebM/VP9) is not supported on this device. Please try a different video format."
        } else {
          "Unable to play this media format. Decoder initialization failed."
        }
      }

      PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> {
        "Unable to load media. Server returned an error."
      }

      PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED -> {
        "Media file is corrupted or in an unsupported format."
      }

      else -> {
        // Check if it's a codec-related error in the cause chain
        val causeMessage = error.cause?.message ?: ""
        if (
          causeMessage.contains("codec", ignoreCase = true) ||
            causeMessage.contains("decoder", ignoreCase = true) ||
            causeMessage.contains("vp9", ignoreCase = true)
        ) {
          "Video codec not supported on this device. The video format may not be compatible."
        } else {
          "Playback error occurred: ${error.message ?: "Unknown error"}"
        }
      }
    }

  return errorMessage
}
