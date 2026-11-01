package dev.jasonpearson.automobile.ctrlproxy

import android.content.Intent
import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.protocol.ErrorResponse
import kotlinx.coroutines.CancellationException

/** An `EXTRACT_HIERARCHY` ADB broadcast, parsed from its intent extras. */
internal data class ExtractHierarchyCommand(
  val uuid: String?,
  val textFilter: String?,
  val disableAllFiltering: Boolean,
)

/**
 * The command an ADB broadcast carries: an `EXTRACT_HIERARCHY` broadcast's extras, or null for any
 * other action, which only triggers the uuid-file cleanup.
 */
internal fun extractHierarchyCommand(intent: Intent): ExtractHierarchyCommand? =
  if (intent.action == CtrlProxy.ACTION_EXTRACT_HIERARCHY) {
    ExtractHierarchyCommand(
      uuid = intent.getStringExtra("uuid"),
      textFilter = intent.getStringExtra("text"),
      disableAllFiltering = intent.getBooleanExtra("disableAllFiltering", false),
    )
  } else {
    null
  }

/** The legacy `OPERATION_RESULT` ADB broadcast; absent data or error extras are left out. */
internal fun operationResultIntent(
  success: Boolean,
  data: String?,
  error: String?,
  timestampMs: Long,
): Intent =
  Intent(CtrlProxy.ACTION_OPERATION_RESULT).apply {
    putExtra("success", success)
    putExtra("timestamp", timestampMs)
    data?.let { putExtra("data", it) }
    error?.let { putExtra("error", it) }
  }

/**
 * Answers the daemon's ADB-broadcast hierarchy fallback: extract, write `hierarchy_<uuid>.json`,
 * push the `hierarchy_update` keyed by the uuid, and reply with the legacy ADB result. A failure
 * also sends a correlated error frame keyed by the uuid, so the daemon's wait fails fast instead of
 * timing out (issue #3089).
 */
internal class HierarchyExtractCommandHandler(private val host: Host) {
  /** The service members an extract command needs. */
  interface Host {
    fun cleanupUuidHierarchyFiles()

    fun extractHierarchy(textFilter: String?, disableAllFiltering: Boolean): ViewHierarchy?

    fun serialize(hierarchy: ViewHierarchy): String

    fun writeHierarchyToFile(hierarchy: ViewHierarchy, filename: String, serialized: String)

    suspend fun broadcastHierarchyUpdate(
      hierarchy: ViewHierarchy,
      serialized: String,
      requestId: String,
    )

    fun releaseFrameContext(hierarchy: ViewHierarchy)

    /** The legacy `ACTION_OPERATION_RESULT` ADB broadcast. */
    fun sendResult(success: Boolean, data: String? = null, error: String? = null)

    /** The correlated WebSocket error frame; null means there is nothing to correlate. */
    suspend fun sendErrorFrame(frame: ErrorResponse?)
  }

  // Any extraction failure must still answer the waiting daemon, never escape the receiver.
  @Suppress("TooGenericExceptionCaught")
  suspend fun handle(command: ExtractHierarchyCommand?) {
    // Clean up any lingering UUID-based hierarchy files before processing new requests
    host.cleanupUuidHierarchyFiles()
    // Null: a command action this handler does not own; only the cleanup applies.
    if (command == null) return

    val uuid = command.uuid
    if (uuid.isNullOrBlank()) {
      // No uuid to correlate a WebSocket error frame to, so only the legacy ADB result is sent.
      host.sendResult(success = false, error = "UUID parameter is required")
      return
    }

    try {
      val hierarchy = host.extractHierarchy(command.textFilter, command.disableAllFiltering)
      if (hierarchy != null) {
        deliver(hierarchy, uuid, command.textFilter)
      } else {
        host.sendResult(success = false, error = HierarchyExtractErrorFrames.NULL_HIERARCHY_ERROR)
        host.sendErrorFrame(HierarchyExtractErrorFrames.nullResultFrame(uuid))
      }
    } catch (e: CancellationException) {
      // Cooperative cancellation (service scope shutting down) must never be converted into an
      // error frame — let it propagate so the coroutine unwinds cleanly.
      throw e
    } catch (e: Exception) {
      Log.e(TAG, "Error extracting hierarchy for uuid=$uuid", e)
      host.sendResult(success = false, error = CorrelatedErrorReporter.causeOf(e))
      host.sendErrorFrame(HierarchyExtractErrorFrames.thrownFrame(uuid, e))
    }
  }

  private suspend fun deliver(hierarchy: ViewHierarchy, uuid: String, textFilter: String?) {
    val filename = "hierarchy_$uuid.json"
    // Explicit request: serialize once and reuse for the file and the wire frame (#5469). Routed
    // through deliverHierarchyFrame so the frame-context entry is released even if the encode
    // throws (leak fix) — the caller's catch still reports the failure frame.
    deliverHierarchyFrame(
      serialize = { host.serialize(hierarchy) },
      write = { serialized -> host.writeHierarchyToFile(hierarchy, filename, serialized) },
      broadcast = { serialized ->
        host.broadcastHierarchyUpdate(hierarchy, serialized = serialized, requestId = uuid)
      },
      releaseFrameContext = { host.releaseFrameContext(hierarchy) },
    )

    val message =
      if (textFilter != null) {
        "Hierarchy extracted with text filter: '$textFilter', saved as $filename"
      } else {
        "Hierarchy extracted successfully, saved as $filename"
      }
    host.sendResult(success = true, data = message)
  }

  private companion object {
    const val TAG = "CtrlProxy"
  }
}
