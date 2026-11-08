package dev.jasonpearson.automobile.playground

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.widget.TextView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class ShareSinkActivityTest {
  @Test
  fun sendTextDisplaysActionMimeSubjectTextAndZeroStreams() {
    val intent =
      Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, "A subject")
        putExtra(Intent.EXTRA_TEXT, "Shared text" as CharSequence)
      }
    assertEquals(
      ShareSinkSummary(Intent.ACTION_SEND, "text/plain", "A subject", "Shared text", 0),
      summarizeShare(intent),
    )
    val activity = Robolectric.buildActivity(ShareSinkActivity::class.java, intent).setup().get()
    assertEquals("Action: android.intent.action.SEND", text(activity, R.id.share_sink_action))
    assertEquals("MIME type: text/plain", text(activity, R.id.share_sink_mime_type))
    assertEquals("Subject: A subject", text(activity, R.id.share_sink_subject))
    assertEquals("Text: Shared text", text(activity, R.id.share_sink_text))
    assertEquals("Stream count: 0", text(activity, R.id.share_sink_stream_count))
  }

  @Test
  fun sendMultipleDisplaysTwoStreamsAndEmptyOptionalFields() {
    val intent = imageIntent(Intent.ACTION_SEND_MULTIPLE)
    val summary = summarizeShare(intent)
    assertEquals(ShareSinkSummary(Intent.ACTION_SEND_MULTIPLE, "image/png", "", "", 2), summary)
    val activity = Robolectric.buildActivity(ShareSinkActivity::class.java, intent).setup().get()
    assertEquals("Stream count: 2", text(activity, R.id.share_sink_stream_count))
  }

  @Test
  fun sendSingleStreamAndMissingExtrasAreSummarized() {
    assertEquals(1, summarizeShare(imageIntent(Intent.ACTION_SEND)).streamCount)
    assertEquals(ShareSinkSummary("", "", "", "", 0), summarizeShare(Intent()))
    assertEquals(0, summarizeShare(Intent(Intent.ACTION_SEND_MULTIPLE)).streamCount)
  }

  @Test
  @Config(sdk = [33])
  fun typedParcelableAccessCountsSingleAndMultipleStreams() {
    assertEquals(1, summarizeShare(imageIntent(Intent.ACTION_SEND)).streamCount)
    assertEquals(2, summarizeShare(imageIntent(Intent.ACTION_SEND_MULTIPLE)).streamCount)
  }

  @Test
  fun manifestResolvesBothActionsForTextAndImages() {
    val context = RuntimeEnvironment.getApplication()
    for (action in listOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)) {
      for (mimeType in listOf("text/plain", "image/png")) {
        val intent =
          Intent(action).apply {
            type = mimeType
            setPackage(context.packageName)
          }
        val matches =
          context.packageManager.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
        assertTrue(
          "$action $mimeType resolves share sink",
          matches.any {
            it.activityInfo.name == ShareSinkActivity::class.java.name && it.activityInfo.exported
          },
        )
      }
    }
  }

  private fun imageIntent(action: String): Intent =
    Intent(action).apply {
      type = "image/png"
      val first = Uri.parse("content://share-sink/one")
      if (action == Intent.ACTION_SEND_MULTIPLE) {
        putParcelableArrayListExtra(
          Intent.EXTRA_STREAM,
          arrayListOf(first, Uri.parse("content://share-sink/two")),
        )
      } else {
        putExtra(Intent.EXTRA_STREAM, first)
      }
    }

  private fun text(activity: ShareSinkActivity, id: Int): String =
    activity.findViewById<TextView>(id).text.toString()
}
