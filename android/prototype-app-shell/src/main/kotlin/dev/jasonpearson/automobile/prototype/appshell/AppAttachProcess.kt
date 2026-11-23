package dev.jasonpearson.automobile.prototype.appshell

import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeResult
import java.util.UUID
import java.util.concurrent.Executor
import kotlinx.coroutines.CoroutineScope
import kotlinx.serialization.json.*

/** A sequence ledger shared by Activity-side runtimes and restored across process launches. */
internal interface AttachEventLedger {
  val appInstanceId: String
  val lastSequence: Long

  fun nextSequence(): Long

  fun nextShowingId(): String
}

/**
 * Retains delivery independently of the UI; tests inject scope, identity and listener startup.
 * Journal writes run on [journalExecutor]; frames reach the host only after the write of the state
 * they expose completes.
 */
@Suppress("LongParameterList") // Independent test seams for identity, journal and its writer.
internal class AppAttachProcess(
  token: String?,
  scope: CoroutineScope,
  appInstanceId: String? = null,
  clock: () -> Long = System::currentTimeMillis,
  log: (String) -> Unit,
  private val startListener: (AppAttachAgent) -> Unit = {},
  journal: AttachJournal = NoAttachJournal,
  journalExecutor: Executor = Executor(Runnable::run),
) : AttachEventLedger, AttachTarget {
  private val journalLock = Any()
  private val writer = AttachJournalWriter(journal, journalExecutor, log)
  private var journalState =
    journal.load()
      ?: AttachJournalState(appInstanceId ?: UUID.randomUUID().toString(), 0, 0, 0, emptyList())
        .also { writer.record(it, flush = true) }
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
      journal =
        object : AttachDeliveryJournal {
          override fun persist(pending: List<PrototypeEvent>, dropped: Long, lastSequence: Long) =
            persistDelivery(pending, dropped, lastSequence)

          override val version: Long
            get() = writer.version

          override suspend fun awaitSaved(version: Long) = writer.awaitSaved(version)
        },
    )

  override val showingId: String?
    get() = target?.showingId

  override val showingStartSequence: Long?
    get() = target?.showingStartSequence

  // The emit that follows carries the counter to disk, so issuing a sequence costs no write.
  override fun nextSequence(): Long =
    synchronized(journalLock) {
      updateJournal(journalState.copy(lastSequence = journalState.lastSequence + 1), flush = false)
      journalState.lastSequence
    }

  override fun nextShowingId(): String =
    synchronized(journalLock) {
      updateJournal(journalState.copy(showing = journalState.showing + 1), flush = true)
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
        flush = true,
      )
    }

  // Call while holding journalLock so snapshot versions follow state order.
  private fun updateJournal(state: AttachJournalState, flush: Boolean) {
    journalState = state
    writer.record(state, flush)
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
