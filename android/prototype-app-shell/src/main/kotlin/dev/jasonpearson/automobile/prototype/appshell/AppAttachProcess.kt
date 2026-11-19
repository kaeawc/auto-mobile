package dev.jasonpearson.automobile.prototype.appshell

import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeResult
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.serialization.json.*

/** A sequence ledger shared by Activity-side runtimes and restored across process launches. */
internal interface AttachEventLedger {
  val appInstanceId: String
  val lastSequence: Long

  fun nextSequence(): Long

  fun nextShowingId(): String
}

/** Retains delivery independently of the UI; tests inject scope, identity and listener startup. */
@Suppress("LongParameterList") // Independent test seams; the journal is the only new one.
internal class AppAttachProcess(
  token: String?,
  scope: CoroutineScope,
  appInstanceId: String? = null,
  clock: () -> Long = System::currentTimeMillis,
  log: (String) -> Unit,
  private val startListener: (AppAttachAgent) -> Unit = {},
  private val journal: AttachJournal = NoAttachJournal,
) : AttachEventLedger, AttachTarget {
  private val journalLock = Any()
  private var journalState =
    journal.load()
      ?: AttachJournalState(appInstanceId ?: UUID.randomUUID().toString(), 0, 0, 0, emptyList())
        .also(journal::save)
  override val appInstanceId = journalState.appInstanceId
  override val lastSequence: Long
    get() = synchronized(journalLock) { journalState.lastSequence }

  private var target: AttachTarget? = null
  private var listenerStarted = false
  val agent =
    AppAttachAgent(
      token,
      this,
      scope,
      clock = clock,
      log = log,
      restored = journalState,
      persist = ::persistDelivery,
    )

  override val showingId: String?
    get() = target?.showingId

  override fun nextSequence(): Long =
    synchronized(journalLock) {
      updateJournal(journalState.copy(lastSequence = journalState.lastSequence + 1))
      journalState.lastSequence
    }

  override fun nextShowingId(): String =
    synchronized(journalLock) {
      updateJournal(journalState.copy(showing = journalState.showing + 1))
      "$appInstanceId:${journalState.showing}"
    }

  private fun persistDelivery(pending: List<PrototypeEvent>, dropped: Long, lastSequence: Long) =
    synchronized(journalLock) {
      updateJournal(
        journalState.copy(
          pending = pending,
          dropped = dropped,
          lastSequence = maxOf(journalState.lastSequence, lastSequence),
        ),
      )
    }

  // Call while holding journalLock to keep counters and delivery updates in the same snapshot.
  private fun updateJournal(state: AttachJournalState) {
    journalState = state
    journal.save(state)
  }

  fun bind(target: AttachTarget): () -> Unit {
    this.target = target
    if (!listenerStarted) {
      listenerStarted = true
      startListener(agent)
    }
    return { if (this.target === target) this.target = null }
  }

  override suspend fun patch(id: String, baseRevision: Long?, ops: JsonArray): PrototypeResult =
    target?.patch(id, baseRevision, ops)
      ?: PrototypeResult(0, success = false, error = "Prototype Activity is not attached")

  override suspend fun status(): JsonObject =
    target?.status()
      ?: buildJsonObject {
        put("shown", false)
        put("id", JsonNull)
        put("pages", JsonObject(emptyMap()))
        put("stacks", JsonObject(emptyMap()))
        put("state", JsonObject(emptyMap()))
        put("lastSequence", lastSequence)
      }
}
