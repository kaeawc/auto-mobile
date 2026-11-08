package dev.jasonpearson.automobile.playground

import android.content.Intent
import android.net.Uri
import android.os.Build

/** A share's metadata, without reading streams or changing the incoming intent. */
data class ShareSinkSummary(
  val action: String,
  val mimeType: String,
  val subject: String,
  val text: String,
  val streamCount: Int,
)

@Suppress("DEPRECATION")
fun summarizeShare(intent: Intent): ShareSinkSummary {
  val streamCount =
    when (intent.action) {
      Intent.ACTION_SEND_MULTIPLE -> {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)?.size ?: 0
        } else {
          intent
            .getParcelableArrayListExtra<android.os.Parcelable>(Intent.EXTRA_STREAM)
            ?.filterIsInstance<Uri>()
            ?.size ?: 0
        }
      }
      Intent.ACTION_SEND -> {
        val stream =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
          } else {
            intent.getParcelableExtra<android.os.Parcelable>(Intent.EXTRA_STREAM) as? Uri
          }
        if (stream == null) 0 else 1
      }
      else -> 0
    }
  return ShareSinkSummary(
    action = intent.action.orEmpty(),
    mimeType = intent.type.orEmpty(),
    subject = intent.getStringExtra(Intent.EXTRA_SUBJECT).orEmpty(),
    text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty(),
    streamCount = streamCount,
  )
}
