package dev.jasonpearson.automobile.protoviewer

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.core.net.toUri
import android.util.Log

/**
 * Published contact for objectionable-content reports and abuse (#16437). The same address is the
 * project's code-of-conduct enforcement contact and is listed in the store metadata.
 */
internal const val REPORT_CONTACT_EMAIL = "automobile+coc@jasonpearson.dev"

/**
 * Identifies reported content without sending it: the label, the spec SHA-256, how it arrived and
 * its link-origin host. The reporter attaches the bundle themselves if they choose to.
 */
internal fun reportDetails(entry: LibraryEntry): String =
  listOfNotNull(
      "label: ${entry.label}",
      "specSha256: ${entry.specSha256}",
      "source: ${entry.source.name}",
      entry.sourceHost?.let { "host: $it" },
    )
    .joinToString("\n")

internal fun reportIntent(subject: String, body: String): Intent =
  Intent(Intent.ACTION_SENDTO, "mailto:".toUri()).apply {
    putExtra(Intent.EXTRA_EMAIL, arrayOf(REPORT_CONTACT_EMAIL))
    putExtra(Intent.EXTRA_SUBJECT, subject)
    putExtra(Intent.EXTRA_TEXT, body)
  }

/** Opens the user's mail app addressed to the report contact; false when no app can send it. */
internal fun launchReport(context: Context, subject: String, body: String): Boolean =
  try {
    context.startActivity(reportIntent(subject, body))
    true
  } catch (error: ActivityNotFoundException) {
    Log.w("ProtoViewerReport", "No app can send the report", error)
    false
  }
