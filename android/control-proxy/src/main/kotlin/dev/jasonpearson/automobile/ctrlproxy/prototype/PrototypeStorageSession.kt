package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.protocol.PrototypeStorageDrop
import dev.jasonpearson.automobile.protocol.PrototypeStorageDropReason
import dev.jasonpearson.automobile.protocol.PrototypeStorageKeyBytes
import dev.jasonpearson.automobile.protocol.PrototypeStorageReport
import dev.jasonpearson.automobile.protocol.PrototypeStorageRestorer
import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import java.io.IOException
import java.lang.ref.WeakReference
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement

/** Coalescing window between a stored key changing and the document being written. */
const val PROTOTYPE_STORAGE_DEBOUNCE_MILLIS = 500L

/** Where a storage problem is explained; a seam so JVM tests need no `android.util.Log`. */
fun interface PrototypeStorageWarn {
  fun warn(message: String, error: Throwable?)
}

private val logWarn = PrototypeStorageWarn { message, error ->
  Log.w("PrototypeStorage", message, error)
}

/**
 * The live sessions of screens that own their storage outside the service (a saved prototype's
 * activity), by id, held weakly. Deleting a saved prototype silences every one of them first, so a
 * pending debounce or a later flush cannot recreate what the delete removed.
 */
class PrototypeStorageSessionRegistry {
  private val sessions = ArrayList<WeakReference<PrototypeStorageSession>>()

  @Synchronized
  fun register(session: PrototypeStorageSession) {
    sessions.removeAll { it.get() == null }
    sessions += WeakReference(session)
  }

  /**
   * Holds back every live session of [id] while its storage is cleaned up. The result either
   * [QuiescedSessions.invalidate]s them for good (the delete went through) or
   * [QuiescedSessions.resume]s them (it failed, and the prototype stays saved and persisting).
   */
  @Synchronized
  fun quiesce(id: String): QuiescedSessions {
    sessions.removeAll { it.get() == null }
    val live = sessions.mapNotNull { it.get() }.filter { it.id == id }
    live.forEach { it.quiesce() }
    return QuiescedSessions(live)
  }

  /** Stops every live session of [id] from writing again; returns how many were live. */
  @Synchronized
  fun invalidate(id: String): Int {
    sessions.removeAll { it.get() == null }
    return sessions.mapNotNull { it.get() }.filter { it.id == id }.onEach { it.invalidate() }.size
  }

  companion object {
    /** The process-wide registry the service and the saved activity share. */
    val Shared = PrototypeStorageSessionRegistry()
  }
}

/** Sessions held back by [PrototypeStorageSessionRegistry.quiesce]. */
class QuiescedSessions internal constructor(private val sessions: List<PrototypeStorageSession>) {
  fun invalidate() = sessions.forEach { it.invalidate() }

  fun resume() = sessions.forEach { it.resume() }
}

/**
 * The shown spec, with the stored values applied, and the session that keeps them current. Making
 * one touches no disk: the deletions and rewrites a show implies are a plan that [commit] applies,
 * so a show the device refuses leaves the stored document as it was.
 */
class PrototypeStorageOpen(
  val spec: PrototypeSpec,
  val session: PrototypeStorageSession?,
  private val plan: suspend () -> Unit = {},
) {
  private var committed = false

  /** Applies the planned deletions and rewrites; call once the window is accepted. Idempotent. */
  suspend fun commit() {
    if (committed) return
    committed = true
    plan()
  }
}

/**
 * Opens a prototype's storage on a show (#12522): reads the stored document, applies the adopted
 * precedence through [PrototypeStorageRestorer] and returns the spec to draw plus a plan to delete
 * what it dropped ([prepare] writes nothing; [PrototypeStorageOpen.commit] applies the plan once
 * the show is accepted). Restoring is not a device write: no revision, no `change` event, and it
 * happens before the first draw because the runtime is built from the returned spec.
 */
class PrototypeStoragePersistence(
  private val store: PrototypeStorageStore,
  private val scheduler: PrototypeScheduler,
  private val io: CoroutineContext = Dispatchers.IO,
  private val debounceMillis: Long = PROTOTYPE_STORAGE_DEBOUNCE_MILLIS,
  private val warn: PrototypeStorageWarn = logWarn,
  /** Where a session is listed so a delete of its id can silence it; null for no listing. */
  private val registry: PrototypeStorageSessionRegistry? = null,
) {
  /**
   * [fits] says whether a restored spec is still acceptable to the device (it was validated before
   * the values were applied); if not, every stored value is dropped and the spec's stand.
   */
  suspend fun open(
    spec: PrototypeSpec,
    fits: (PrototypeSpec) -> Boolean = { true },
  ): PrototypeStorageOpen = prepare(spec, null, fits).also { it.commit() }

  /**
   * Like [open] but side-effect-free: nothing on disk changes until [PrototypeStorageOpen.commit].
   */
  suspend fun prepare(
    spec: PrototypeSpec,
    /**
     * Values a same-id session could not write (its disk refused): laid over the disk record so a
     * re-show does not revert them, then restored under the usual rules and written again.
     */
    unsaved: PrototypeStoredValues? = null,
    fits: (PrototypeSpec) -> Boolean = { true },
  ): PrototypeStorageOpen {
    val loaded = withContext(io) { store.load(spec.id) }
    val onDisk =
      when (loaded) {
        is PrototypeStorageLoad.Loaded -> loaded.stored
        PrototypeStorageLoad.Missing -> null
        is PrototypeStorageLoad.Corrupt -> {
          warn.warn(
            "Stored values of ${spec.id} are unusable, using the spec's: ${loaded.message}",
            null,
          )
          null
        }
      }
    val stored =
      if (unsaved == null) onDisk
      else
        PrototypeStoredValues(
          unsaved.version,
          onDisk?.takeIf { it.version == unsaved.version }?.values.orEmpty() + unsaved.values,
        )
    var restore = PrototypeStorageRestorer.restore(spec, stored)
    if (restore.applied.isNotEmpty() && !fits(restore.spec)) {
      warn.warn("Stored values of ${spec.id} no longer fit the spec, using the spec's", null)
      restore =
        restore.copy(
          spec = spec,
          applied = emptyList(),
          dropped =
            restore.dropped +
              restore.applied.map { PrototypeStorageDrop(it, PrototypeStorageDropReason.MISMATCH) },
        )
    }
    val kept = stored?.values.orEmpty().filterKeys { it in restore.applied }
    // Dropped and corrupt entries are deleted on commit, so the next show does not meet them.
    val rewriteNeeded =
      loaded !is PrototypeStorageLoad.Missing &&
        (restore.dropped.isNotEmpty() || stored == null || spec.storage == null)
    val plan: suspend () -> Unit = {
      if (rewriteNeeded) rewrite(spec.id, stored?.version, kept)
    }
    val block = spec.storage ?: return PrototypeStorageOpen(restore.spec, null, plan)
    val session =
      PrototypeStorageSession(
        id = spec.id,
        version = block.version,
        keys = block.keys,
        store = store,
        scheduler = scheduler,
        io = io,
        debounceMillis = debounceMillis,
        warn = warn,
        stored = kept,
        baseline = PrototypeStorageRestorer.currentValues(restore.spec),
        // What the disk holds is not what the session does when the unsaved values were carried.
        persisted =
          if (unsaved == null) kept
          else onDisk?.takeIf { it.version == block.version }?.values.orEmpty(),
      )
    registry?.register(session)
    return PrototypeStorageOpen(restore.spec, session, plan)
  }

  /** Clears an id nobody is showing: the stored keys removed, from disk alone. */
  suspend fun clear(id: String): Int =
    withContext(io) {
      val count = (store.load(id) as? PrototypeStorageLoad.Loaded)?.stored?.values?.size ?: 0
      store.delete(id)
      count
    }

  private suspend fun rewrite(id: String, version: Int?, kept: Map<String, JsonElement>) {
    try {
      withContext(io) {
        if (kept.isEmpty() || version == null) store.delete(id)
        else store.save(id, PrototypeStoredValues(version, kept))
      }
    } catch (error: CancellationException) {
      throw error
    } catch (error: IOException) {
      warn.warn("Dropped stored values of $id could not be deleted: ${error.message}", error)
    }
  }
}

/**
 * One shown prototype's storage. [record] diffs the shown spec's listed keys against what it last
 * saw and stores each changed value; the document is written [debounceMillis] after the first
 * change of a burst, on [flush] (dismissal) or never if the prototype is cleared first. A value
 * that would take the stored total over `MAX_PROTOTYPE_STORAGE_BYTES` stays live but is not stored;
 * its previous stored value stays and the key is listed in [PrototypeStorageReport]. A listed data
 * pointer that a write removes loses its stored value, so the spec's returns next show.
 */
class PrototypeStorageSession
internal constructor(
  val id: String,
  private val version: Int,
  private val keys: List<String>,
  private val store: PrototypeStorageStore,
  private val scheduler: PrototypeScheduler,
  private val io: CoroutineContext,
  private val debounceMillis: Long,
  private val warn: PrototypeStorageWarn,
  stored: Map<String, JsonElement>,
  baseline: Map<String, JsonElement>,
  persisted: Map<String, JsonElement> = stored,
) {
  private val lock = Any()
  private val values = LinkedHashMap(stored)

  /** What the disk holds, as far as this session knows: the last document it wrote or loaded. */
  private var persistedValues = LinkedHashMap(persisted)
  private val sizes =
    stored.mapValuesTo(HashMap()) { (key, value) ->
      PrototypeStorageRestorer.entryBytes(key, value)
    }
  private val lastSeen = HashMap(baseline)
  private val skipped = LinkedHashSet<String>()
  private var dirty = false
  private var pending: PrototypeScheduledTask? = null

  /** Bumped by [clear]: a snapshot taken before it must never reach the disk afterwards. */
  private var generation = 0L

  /** Set once the id was deleted: nothing this session holds may reach the disk again. */
  private var invalidated = false

  /** Set while a delete is cleaning up: writes wait, and resume if the cleanup fails. */
  private var quiesced = false

  /** Orders every disk operation of this session, so a clear cannot overtake an older save. */
  private val diskLock = Mutex()

  init {
    // Keys that differ from the disk are written again, after the usual debounce.
    if (persisted != values) markDirty()
  }

  /** Notes the shown spec's listed values; stores those that changed. Cheap when none did. */
  fun record(spec: PrototypeSpec) {
    val now = PrototypeStorageRestorer.currentValues(spec)
    synchronized(lock) {
      for (key in keys) {
        val value = now[key]
        if (value == lastSeen[key]) continue
        if (value == null) lastSeen.remove(key) else lastSeen[key] = value
        remember(key, value)
      }
    }
  }

  private fun remember(key: String, value: JsonElement?) {
    if (value == null) {
      skipped.remove(key)
      sizes.remove(key)
      if (values.remove(key) != null) markDirty()
      return
    }
    val bytes = PrototypeStorageRestorer.entryBytes(key, value)
    val total = sizes.values.sum() - (sizes[key] ?: 0) + bytes
    if (total > PrototypeSpecValidator.MAX_PROTOTYPE_STORAGE_BYTES) {
      skipped += key
      return
    }
    skipped.remove(key)
    sizes[key] = bytes
    values[key] = value
    markDirty()
  }

  private fun markDirty() {
    if (invalidated) return
    dirty = true
    if (quiesced) return
    if (pending == null)
      pending = scheduler.schedule(debounceMillis) { write(cancelPending = false) }
  }

  /** Writes anything not yet written; called on dismissal and before a same-id show. */
  suspend fun flush() = write(cancelPending = true)

  private suspend fun write(cancelPending: Boolean) {
    var snapshotGeneration = 0L
    val document =
      synchronized(lock) {
        // The scheduled task is the caller when it is not cancelled: it must not cancel itself.
        if (cancelPending) pending?.cancel()
        pending = null
        if (!dirty || invalidated || quiesced) return
        dirty = false
        snapshotGeneration = generation
        PrototypeStoredValues(version, LinkedHashMap(values))
      }
    try {
      diskLock.withLock {
        // A clear that ran after the snapshot already emptied the disk; the snapshot is stale.
        if (synchronized(lock) { generation != snapshotGeneration }) return
        withContext(io) {
          if (document.values.isEmpty()) store.delete(id) else store.save(id, document)
        }
        synchronized(lock) { persistedValues = LinkedHashMap(document.values) }
      }
    } catch (error: CancellationException) {
      markDirtyUnlessCleared(snapshotGeneration)
      throw error
    } catch (error: IOException) {
      markDirtyUnlessCleared(snapshotGeneration)
      warn.warn("Could not store the values of $id: ${error.message}", error)
    }
  }

  private fun markDirtyUnlessCleared(snapshotGeneration: Long) =
    synchronized(lock) { if (generation == snapshotGeneration) dirty = true }

  /** The values that never reached the disk (a refused write), or null when nothing is owed. */
  internal fun unsavedValues(): PrototypeStoredValues? =
    synchronized(lock) {
      if (dirty && !invalidated) PrototypeStoredValues(version, LinkedHashMap(values)) else null
    }

  /** Holds writes back while a delete cleans up; [resume] undoes it if the cleanup fails. */
  internal fun quiesce() {
    synchronized(lock) {
      quiesced = true
      pending?.cancel()
      pending = null
      generation++
    }
  }

  /** The delete failed: the session persists again, writing what it holds from now. */
  internal fun resume() {
    synchronized(lock) {
      if (!quiesced || invalidated) return
      quiesced = false
      markDirty()
    }
  }

  /** The id was deleted: drop the pending write and every later one. Touches no disk. */
  internal fun invalidate() {
    synchronized(lock) {
      invalidated = true
      pending?.cancel()
      pending = null
      dirty = false
      generation++
      values.clear()
      sizes.clear()
      skipped.clear()
    }
  }

  /**
   * Forgets every stored value of this id, writes nothing pending; returns the keys that were
   * stored (on disk), not those still waiting in the debounce window. If the disk refuses the
   * delete, what was forgotten is put back (under anything recorded since) and the keys are owed a
   * write again, so the live ledger never claims a clean slate the disk does not have.
   */
  suspend fun clear(): Int {
    val forgotten = LinkedHashMap<String, JsonElement>()
    val wasDirty: Boolean
    val removed =
      synchronized(lock) {
        pending?.cancel()
        pending = null
        wasDirty = dirty
        dirty = false
        generation++
        forgotten.putAll(values)
        persistedValues.size.also {
          values.clear()
          sizes.clear()
          skipped.clear()
        }
      }
    try {
      diskLock.withLock { withContext(io) { store.delete(id) } }
    } catch (error: CancellationException) {
      restoreAfterFailedClear(forgotten, wasDirty)
      throw error
    } catch (error: IOException) {
      restoreAfterFailedClear(forgotten, wasDirty)
      throw error
    }
    synchronized(lock) { persistedValues = LinkedHashMap() }
    return removed
  }

  private fun restoreAfterFailedClear(
    forgotten: Map<String, JsonElement>,
    wasDirty: Boolean,
  ) =
    synchronized(lock) {
      for ((key, value) in forgotten) {
        if (key in values) continue
        values[key] = value
        sizes[key] = PrototypeStorageRestorer.entryBytes(key, value)
      }
      if (wasDirty || values.isNotEmpty()) markDirty()
    }

  fun report(): PrototypeStorageReport =
    synchronized(lock) {
      PrototypeStorageReport(
        version = version,
        keys =
          keys.filter { it in values }.map { PrototypeStorageKeyBytes(it, sizes.getValue(it)) },
        totalBytes = sizes.values.sum(),
        skippedKeys = keys.filter { it in skipped }.ifEmpty { null },
      )
    }
}
