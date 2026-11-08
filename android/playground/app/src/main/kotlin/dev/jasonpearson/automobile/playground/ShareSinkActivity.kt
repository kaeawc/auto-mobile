package dev.jasonpearson.automobile.playground

import android.os.Bundle
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class ShareSinkActivity : AppCompatActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_share_sink)
    val summary = summarizeShare(intent)
    findViewById<TextView>(R.id.share_sink_action).text =
      getString(R.string.share_sink_action, summary.action)
    findViewById<TextView>(R.id.share_sink_mime_type).text =
      getString(R.string.share_sink_mime_type, summary.mimeType)
    findViewById<TextView>(R.id.share_sink_subject).text =
      getString(R.string.share_sink_subject, summary.subject)
    findViewById<TextView>(R.id.share_sink_text).text =
      getString(R.string.share_sink_text, summary.text)
    findViewById<TextView>(R.id.share_sink_stream_count).text =
      getString(R.string.share_sink_stream_count, summary.streamCount)
  }
}
