package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import dev.jasonpearson.automobile.protocol.PrototypeRouteRuntime
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.protocol.PrototypeStackSnapshot
import dev.jasonpearson.automobile.protocol.PrototypeStorageDrop
import dev.jasonpearson.automobile.protocol.PrototypeStorageDropReason
import dev.jasonpearson.automobile.protocol.PrototypeStorageKeyBytes
import dev.jasonpearson.automobile.protocol.PrototypeStorageReport
import dev.jasonpearson.automobile.protocol.PrototypeStorageRestorer
import dev.jasonpearson.automobile.protocol.PrototypeStorageSecureMetadata
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
import kotlinx.serialization.json.JsonPrimitive

/** Coalescing window between a stored key changing and the document being written. */
internal const val PROTOTYPE_STORAGE_DEBOUNCE_MILLIS = 500L

/** Where a storage problem is explained; a seam so JVM tests need no `android.util.Log`. */
@InternalAutoMobilePrototypeApi
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
@InternalAutoMobilePrototypeApi
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
@InternalAutoMobilePrototypeApi
class QuiescedSessions internal constructor(private val sessions: List<PrototypeStorageSession>) {
  fun invalidate() = sessions.forEach { it.invalidate() }

  fun resume() = sessions.forEach { it.resume() }
}

/**
 * The shown spec, with the stored values applied, and the session that keeps them current. Making
 * one touches no disk: the deletions and rewrites a show implies are a plan that [commit] applies,
 * so a show the device refuses leaves the stored document as it was.
 */
@InternalAutoMobilePrototypeApi
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

/** The plain and optional secure backends used together by a storage session. */
@InternalAutoMobilePrototypeApi
class PrototypeStorageBackends(
  val plain: PrototypeStorageStore,
  val secure: PrototypeSecureValueStore? = null,
)

/**
 * Opens a prototype's storage on a show (#12522): reads the stored document, applies the adopted
 * precedence through [PrototypeStorageRestorer] and returns the spec to draw plus a plan to delete
 * what it dropped ([prepare] writes nothing; [PrototypeStorageOpen.commit] applies the plan once
 * the show is accepted). Restoring is not a device write: no revision, no `change` event, and it
 * happens before the first draw because the runtime is built from the returned spec.
 */
@InternalAutoMobilePrototypeApi
class PrototypeStoragePersistence(
  backends: PrototypeStorageBackends,
  private val scheduler: PrototypeScheduler,
  private val io: CoroutineContext = Dispatchers.IO,
  private val debounceMillis: Long = PROTOTYPE_STORAGE_DEBOUNCE_MILLIS,
  private val warn: PrototypeStorageWarn = logWarn,
  /** Where a session is listed so a delete of its id can silence it; null for no listing. */
  private val registry: PrototypeStorageSessionRegistry? = null,
) {
  private val store = backends.plain
  private val secure = backends.secure

  constructor(
    store: PrototypeStorageStore,
    scheduler: PrototypeScheduler,
    io: CoroutineContext = Dispatchers.IO,
    debounceMillis: Long = PROTOTYPE_STORAGE_DEBOUNCE_MILLIS,
    warn: PrototypeStorageWarn = logWarn,
    registry: PrototypeStorageSessionRegistry? = null,
  ) : this(PrototypeStorageBackends(store), scheduler, io, debounceMillis, warn, registry)

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
            if (spec.storage?.secure.orEmpty().isEmpty())
              "Stored values of ${spec.id} are unusable, using the spec's: ${loaded.message}"
            else "Stored prototype values are unusable, using the spec's",
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
    val secureValues =
      PrototypeSecureStoragePreparation(spec, withContext(io) { secure?.load(spec.id) }, unsaved)
    var restore = PrototypeStorageRestorer.restore(secureValues.restored, stored)
    if ((restore.applied.isNotEmpty() || secureValues.applied) && !fits(restore.spec)) {
      secureValues.reject()
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
      if (rewriteNeeded)
        rewrite(spec.id, stored?.version, kept, spec.storage?.secure.orEmpty().isNotEmpty())
      withContext(io) { secureValues.commit(secure) }
    }
    val session =
      session(
        restore.spec,
        kept,
        if (unsaved == null) kept
        else onDisk?.takeIf { it.version == spec.storage?.version }?.values.orEmpty(),
        secureValues,
      )
    return PrototypeStorageOpen(restore.spec, session, plan)
  }

  private fun session(
    spec: PrototypeSpec,
    kept: Map<String, JsonElement>,
    persisted: Map<String, JsonElement>,
    secureValues: PrototypeSecureStoragePreparation,
  ): PrototypeStorageSession? {
    val block = spec.storage ?: return null
    return PrototypeStorageSession(
        id = spec.id,
        version = block.version,
        keys = block.keys,
        store = store,
        scheduler = scheduler,
        io = io,
        debounceMillis = debounceMillis,
        warn = warn,
        stored = kept,
        baseline = restoredBaseline(spec, kept),
        secureStore = secure,
        secureKeys = block.secure.orEmpty(),
        persistentSecureKeys = secureValues.keys,
        secureStored = secureValues.kept,
        securePersisted = secureValues.persisted,
        secureBaseline = secureCurrentValues(spec),
        persisted = persisted,
      )
      .also { registry?.register(it) }
  }

  /**
   * What the restored show holds for its listed keys. A restored stack path lives in the runtime,
   * not the spec, so it is seeded from [kept] and an unchanged path is not written again. A stack
   * with nothing kept is seeded at its start, so a path never navigated is never stored and a later
   * spec's `start` still applies.
   */
  private fun restoredBaseline(spec: PrototypeSpec, kept: Map<String, JsonElement>) =
    PrototypeStorageRestorer.currentValues(
      spec,
      stackNodes(spec.root).mapValues { (_, node) -> PrototypeStackSnapshot(listOf(node.start)) },
    ) + kept.filterKeys { it.startsWith(PrototypeRouteRuntime.STACK_STORAGE_PREFIX) }

  /** Clears an id nobody is showing: the stored keys removed, from disk alone. */
  suspend fun clear(id: String): Int =
    withContext(io) {
      val count = (store.load(id) as? PrototypeStorageLoad.Loaded)?.stored?.values?.size ?: 0
      store.delete(id)
      count + (secure?.delete(id) ?: 0)
    }

  private suspend fun rewrite(
    id: String,
    version: Int?,
    kept: Map<String, JsonElement>,
    redact: Boolean,
  ) {
    try {
      withContext(io) {
        if (kept.isEmpty() || version == null) store.delete(id)
        else store.save(id, PrototypeStoredValues(version, kept))
      }
    } catch (error: CancellationException) {
      throw error
    } catch (error: IOException) {
      if (redact) warn.warn("Dropped stored prototype values could not be deleted", null)
      else warn.warn("Dropped stored values of $id could not be deleted: ${error.message}", error)
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
@InternalAutoMobilePrototypeApi
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
  private val secureStore: PrototypeSecureValueStore? = null,
  private val secureKeys: List<String> = emptyList(),
  private val persistentSecureKeys: List<String> = emptyList(),
  secureStored: Map<String, JsonElement> = emptyMap(),
  securePersisted: Map<String, JsonElement> = secureStored,
  secureBaseline: Map<String, JsonElement> = emptyMap(),
) {
  private val lock = Any()
  private val values = LinkedHashMap(stored)
  private val secureValues = LinkedHashMap(secureStored)
  private var persistedSecureValues: Map<String, JsonElement> = LinkedHashMap(securePersisted)
  private var secureBaselineStale = false
  private val secureLastSeen = HashMap(secureBaseline)

  /** What the disk holds, as far as this session knows: the last document it wrote or loaded. */
  private var persistedValues: Map<String, JsonElement> = LinkedHashMap(persisted)
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
    if (persisted != values || securePersisted != secureStored) markDirty()
  }

  /**
   * Notes the shown spec's listed values; stores those that changed. Cheap when none did. Listed
   * `stack:<id>` keys are left as they are: only [record] with the stacks sees them.
   */
  fun record(spec: PrototypeSpec) =
    record(
      PrototypeStorageRestorer.currentValues(spec) + secureCurrentValues(spec),
      includeStacks = false,
    )

  /** [record] with the listed `stack:<id>` paths of [stacks] too (#14188). */
  fun record(spec: PrototypeSpec, stacks: Map<String, PrototypeStackSnapshot>) =
    record(
      PrototypeStorageRestorer.currentValues(spec, stacks) + secureCurrentValues(spec),
      includeStacks = true,
    )

  /** The value this session holds for [storageKey]: what was restored until it is recorded. */
  fun stored(storageKey: String): JsonElement? = synchronized(lock) { values[storageKey] }

  private fun record(now: Map<String, JsonElement>, includeStacks: Boolean) {
    synchronized(lock) {
      for (key in keys) {
        if (!includeStacks && key.startsWith(PrototypeRouteRuntime.STACK_STORAGE_PREFIX)) continue
        val value = now[key]
        if (value == lastSeen[key]) continue
        if (value == null) lastSeen.remove(key) else lastSeen[key] = value
        remember(key, value)
      }
      recordSecure(now)
    }
  }

  private fun recordSecure(now: Map<String, JsonElement>) {
    if (secureStore != null)
      for (key in persistentSecureKeys) {
        val value = now[key]
        if (value == secureLastSeen[key]) continue
        if (value == null) secureLastSeen.remove(key) else secureLastSeen[key] = value
        if (value == null) {
          if (secureValues.remove(key) != null) markDirty()
          skipped.remove(key)
        } else if (secureValueBytes(value) <= PrototypeStorageRestorer.maxSecureValueBytes) {
          secureValues[key] = value
          skipped.remove(key)
          markDirty()
        } else skipped += key
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
        PrototypeStoredValues(version, LinkedHashMap(values), LinkedHashMap(secureValues))
      }
    try {
      diskLock.withLock {
        // A clear that ran after the snapshot already emptied the disk; the snapshot is stale.
        if (synchronized(lock) { generation != snapshotGeneration }) return
        withContext(io) {
          if (document.values.isEmpty()) store.delete(id)
          else store.save(id, document.copy(secure = emptyMap()))
          writeSecure(document)
        }
        synchronized(lock) {
          persistedValues = LinkedHashMap(document.values)
          persistedSecureValues = LinkedHashMap(document.secure)
          if (generation == snapshotGeneration) secureBaselineStale = false
        }
      }
    } catch (error: CancellationException) {
      markDirtyUnlessCleared(snapshotGeneration)
      throw error
    } catch (error: IOException) {
      markDirtyUnlessCleared(snapshotGeneration)
      if (secureKeys.isNotEmpty()) warn.warn("Could not store prototype values", null)
      else warn.warn("Could not store the values of $id: ${error.message}", error)
    }
  }

  private fun writeSecure(document: PrototypeStoredValues) {
    if (secureStore == null) return
    if (!synchronized(lock) { secureBaselineStale || document.secure != persistedSecureValues })
      return
    if (document.secure.isEmpty()) secureStore.delete(id)
    else secureStore.save(id, PrototypeStoredValues(version, document.secure))
  }

  private fun markDirtyUnlessCleared(snapshotGeneration: Long) =
    synchronized(lock) { if (generation == snapshotGeneration) dirty = true }

  /** The values that never reached the disk (a refused write), or null when nothing is owed. */
  @InternalAutoMobilePrototypeApi
  fun unsavedValues(): PrototypeStoredValues? =
    synchronized(lock) {
      if (dirty && !invalidated)
        PrototypeStoredValues(version, LinkedHashMap(values), LinkedHashMap(secureValues))
      else null
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
  @InternalAutoMobilePrototypeApi
  fun invalidate() {
    synchronized(lock) {
      invalidated = true
      pending?.cancel()
      pending = null
      dirty = false
      generation++
      values.clear()
      secureValues.clear()
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
    val secureForgotten = LinkedHashMap<String, JsonElement>()
    val removed =
      synchronized(lock) {
        pending?.cancel()
        pending = null
        dirty = false
        generation++
        forgotten.putAll(values)
        secureForgotten.putAll(secureValues)
        (persistedValues.size + persistedSecureValues.size).also {
          secureValues.clear()
          values.clear()
          sizes.clear()
          skipped.clear()
        }
      }
    try {
      diskLock.withLock {
        withContext(io) {
          store.delete(id)
          secureStore?.delete(id)
        }
      }
    } catch (error: CancellationException) {
      restoreAfterFailedClear(forgotten, secureForgotten)
      throw error
    } catch (error: IOException) {
      restoreAfterFailedClear(forgotten, secureForgotten)
      throw error
    }
    synchronized(lock) {
      persistedValues = LinkedHashMap()
      persistedSecureValues = LinkedHashMap()
      secureBaselineStale = false
    }
    return removed
  }

  private fun restoreAfterFailedClear(
    forgotten: Map<String, JsonElement>,
    secureForgotten: Map<String, JsonElement>,
  ) =
    synchronized(lock) {
      for ((key, value) in forgotten) {
        if (key in values) continue
        values[key] = value
        sizes[key] = PrototypeStorageRestorer.entryBytes(key, value)
      }
      for ((key, value) in secureForgotten) secureValues.putIfAbsent(key, value)
      secureBaselineStale = true
      markDirty()
    }

  fun report(): PrototypeStorageReport =
    synchronized(lock) {
      PrototypeStorageReport(
        version = version,
        keys =
          keys.filter { it in values }.map { PrototypeStorageKeyBytes(it, sizes.getValue(it)) },
        totalBytes = sizes.values.sum(),
        skippedKeys = (keys + secureKeys).filter { it in skipped }.ifEmpty { null },
        secure =
          secureKeys
            .map { key ->
              val value = if (secureBaselineStale) null else persistedSecureValues[key]
              PrototypeStorageSecureMetadata(
                key,
                value != null,
                value?.let(::secureValueBytes) ?: 0,
              )
            }
            .ifEmpty { null },
      )
    }
}

private fun secureCurrentValues(spec: PrototypeSpec): Map<String, JsonElement> =
  spec.storage
    ?.secure
    .orEmpty()
    .mapNotNull { key ->
      (spec.state?.get(key.removePrefix("state:"))
          as? dev.jasonpearson.automobile.protocol.PrototypeScalar.Text)
        ?.let { key to JsonPrimitive(it.value) }
    }
    .toMap()

private fun secureValueBytes(value: JsonElement): Int =
  (value as JsonPrimitive).content.toByteArray(Charsets.UTF_8).size
