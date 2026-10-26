package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeResultSink
import dev.jasonpearson.automobile.protocol.PrototypeAppearance
import dev.jasonpearson.automobile.protocol.PrototypeHiddenReason
import dev.jasonpearson.automobile.protocol.PrototypePatchConflict
import dev.jasonpearson.automobile.protocol.PrototypeStackSnapshot
import dev.jasonpearson.automobile.protocol.PrototypeStatusEntry
import dev.jasonpearson.automobile.protocol.SavedPrototypeEntry
import dev.jasonpearson.automobile.protocol.SavedPrototypeErrorCode
import dev.jasonpearson.automobile.protocol.SavedPrototypeInfo
import dev.jasonpearson.automobile.protocol.SavedPrototypePinInfo

/** The socket the prototype results leave through; the service resolves its lateinit server. */
internal interface PrototypeResultTransport {
  fun isRunning(): Boolean

  /** Broadcast the frame [buildFrame] returns, routed by its request id. */
  suspend fun broadcastFrame(buildFrame: () -> String)
}

/**
 * Turns the prototype controllers' results into correlated `prototype_result` frames. Each send is
 * skipped while the socket is down and is guarded, so a throw while sending still yields a
 * correlated failure frame instead of a request that hangs to its timeout (#3045).
 */
internal class PrototypeResultBroadcaster(
  private val transport: PrototypeResultTransport,
  private val resultBroadcaster: ResultBroadcaster,
) : PrototypeResultSink {
  private suspend fun emit(requestId: String?, buildFrame: () -> String) {
    if (!transport.isRunning()) return
    resultBroadcaster.guard(requestId, ACTION) { transport.broadcastFrame(buildFrame) }
  }

  override suspend fun send(requestId: String?, success: Boolean, error: String?) =
    sendWithMissingAssets(requestId, success, error, emptyList())

  override suspend fun sendWithMissingAssets(
    requestId: String?,
    success: Boolean,
    error: String?,
    missingAssets: List<String>,
  ) = emit(requestId) { prototypeResultFrame(requestId, success, error, missingAssets) }

  override suspend fun sendPinned(requestId: String?, pin: SavedPrototypePinInfo) =
    emit(requestId) { prototypePinnedFrame(requestId, pin) }

  override suspend fun sendSaved(requestId: String?, saved: SavedPrototypeInfo) =
    emit(requestId) { prototypeSavedFrame(requestId, saved) }

  override suspend fun sendSavedList(requestId: String?, entries: List<SavedPrototypeEntry>) =
    emit(requestId) { prototypeSavedListFrame(requestId, entries) }

  override suspend fun sendRefusal(
    requestId: String?,
    code: SavedPrototypeErrorCode,
    error: String,
  ) = emit(requestId) { prototypeRefusalFrame(requestId, code, error) }

  override suspend fun sendPatched(
    requestId: String?,
    success: Boolean,
    error: String?,
    revision: Long?,
    conflict: PrototypePatchConflict?,
  ) =
    emit(requestId) {
      prototypeResultFrame(requestId, success, error, revision = revision, conflict = conflict)
    }

  override suspend fun sendShown(
    requestId: String?,
    missingAssets: List<String>,
    appearance: PrototypeAppearance,
    hiddenReason: PrototypeHiddenReason?,
  ) =
    emit(requestId) {
      prototypeResultFrame(
        requestId,
        true,
        null,
        missingAssets,
        appearance,
        hiddenReason = hiddenReason,
      )
    }

  private val shownBackdrops = java.util.concurrent.ConcurrentHashMap<String, String>()

  override fun noteShownBackdrop(requestId: String?, backdrop: String) {
    shownBackdrops[requestId.orEmpty()] = backdrop
  }

  override suspend fun sendShownNavigation(
    requestId: String?,
    missingAssets: List<String>,
    appearance: PrototypeAppearance,
    pages: Map<String, Int>,
    stacks: Map<String, PrototypeStackSnapshot>,
    hiddenReason: PrototypeHiddenReason?,
  ) =
    emit(requestId) {
      prototypeResultFrame(
        requestId,
        true,
        null,
        missingAssets,
        appearance,
        pages = pages,
        stacks = stacks,
        hiddenReason = hiddenReason,
        backdrop = shownBackdrops.remove(requestId.orEmpty()),
      )
    }

  override suspend fun sendAdvanced(requestId: String?, fired: Int) =
    emit(requestId) { prototypeResultFrame(requestId, true, null, fired = fired) }

  override suspend fun sendAdvanceFailed(requestId: String?, fired: Int, error: String) =
    emit(requestId) { prototypeResultFrame(requestId, false, error, fired = fired) }

  override suspend fun sendCleared(requestId: String?, cleared: Int) =
    emit(requestId) { prototypeClearedFrame(requestId, cleared) }

  override suspend fun sendPrototypeStatus(
    requestId: String?,
    prototypes: List<PrototypeStatusEntry>,
    droppedEvents: Long,
  ) = emit(requestId) { prototypeStatusFrame(requestId, prototypes, droppedEvents) }

  private companion object {
    const val ACTION = "prototype_result"
  }
}
