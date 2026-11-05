package dev.jasonpearson.automobile.protoviewer

import android.content.Context
import kotlinx.coroutines.withContext

/** Library Report, Hide and Block on received content (#16437), kept out of the activity. */
internal class ReceivedContentHandler(
  private val context: Context,
  private val services: ProtoViewerServices,
) {
  /** False when no app can send the report mail. */
  fun report(entry: LibraryEntry): Boolean =
    launchReport(
      context,
      context.getString(R.string.report_subject),
      context.getString(R.string.report_body, reportDetails(entry)),
    )

  suspend fun hide(
    entry: LibraryEntry,
    shown: LibraryResult<List<LibraryEntry>>?,
  ): LibraryResult<List<LibraryEntry>> =
    update(shown, { it.specSha256 == entry.specSha256 }) { hide(entry.specSha256) }

  suspend fun block(
    entry: LibraryEntry,
    shown: LibraryResult<List<LibraryEntry>>?,
  ): LibraryResult<List<LibraryEntry>>? {
    val host = entry.sourceHost ?: return shown
    return update(shown, { it.sourceHost == host }) { block(host) }
  }

  /** Like Delete, closes every open viewer of content the change hides, not just this row's. */
  private suspend fun update(
    shown: LibraryResult<List<LibraryEntry>>?,
    affected: (LibraryEntry) -> Boolean,
    change: ContentBlocklist.() -> Unit,
  ): LibraryResult<List<LibraryEntry>> {
    (shown as? LibraryResult.Success)
      ?.value
      ?.filter { it.isReceived && affected(it) }
      ?.forEach { ViewerLaunch.close(context, it.libraryId) }
    return withContext(services.io) {
      services.blocklist.change()
      // Hidden content must not keep holding library quota: delete it, keep only the hash/host.
      services.repository.purgeBlocked()
      services.repository.list()
    }
  }
}
