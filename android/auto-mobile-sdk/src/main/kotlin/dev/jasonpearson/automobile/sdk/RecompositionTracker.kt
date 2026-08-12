package dev.jasonpearson.automobile.sdk

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONArray
import org.json.JSONObject

internal object RecompositionTracker {
  private const val WINDOW_MS = 1000L
  private const val BROADCAST_INTERVAL_MS = 1000L

  // Upper bound on tracked entries. Apps may key tracking per instance (e.g.
  // autoMobileRecomposition("row-$itemId") over a long/paginated feed), which
  // would otherwise grow `entries` without bound for the life of the process
  // (issue #3708, the twin of iOS #3624). When exceeded we evict the
  // least-recently-touched entries in a batch to amortize the eviction scan.
  private const val MAX_ENTRIES = 512
  private const val EVICTION_BATCH = 64

  private val entries = ConcurrentHashMap<String, Entry>()

  // Monotonic tick stamped on every record; used as the LRU key for eviction.
  private val touchSequence = AtomicLong(0)
  private val enabled = AtomicBoolean(false)
  private val handler = Handler(Looper.getMainLooper())
  private val controlReceiverRegistrar = NetworkControlReceiverRegistrar { _, intent ->
    if (intent?.action == AutoMobileSDK.ACTION_RECOMPOSITION_CONTROL) {
      setEnabled(intent.getBooleanExtra(AutoMobileSDK.EXTRA_RECOMPOSITION_ENABLED, false))
    }
  }
  private var context: Context? = null

  fun initialize(context: Context) {
    if (this.context != null) return
    this.context = context.applicationContext
    registerControlReceiver(context.applicationContext)
  }

  /** Tears down tracker state so resources are released and [initialize] can be called again. */
  fun reset() {
    setEnabled(false)
    val ctx = context
    if (ctx != null) {
      controlReceiverRegistrar.unregister(ctx)
    }
    context = null
  }

  fun recordRecomposition(
    id: String,
    composableName: String? = null,
    resourceId: String? = null,
    testTag: String? = null,
    parentChain: List<String>? = null,
    stableAnnotated: Boolean? = null,
    rememberedCount: Int? = null,
    likelyCause: String? = null,
  ) {
    if (!enabled.get()) {
      return
    }
    val entry = entries.computeIfAbsent(id) { Entry(id) }
    entry.record(
      composableName,
      resourceId,
      testTag,
      parentChain,
      stableAnnotated,
      rememberedCount,
      likelyCause,
    )
    enforceEntryCap()
  }

  fun recordDuration(id: String, durationMs: Double) {
    if (!enabled.get()) {
      return
    }
    val entry = entries.computeIfAbsent(id) { Entry(id) }
    entry.recordDuration(durationMs)
    enforceEntryCap()
  }

  /**
   * Evict least-recently-touched entries once the cap is exceeded, down to a low-water mark so the
   * O(n) scan runs at most once per [EVICTION_BATCH] inserts (issue #3708).
   */
  private fun enforceEntryCap() {
    if (entries.size <= MAX_ENTRIES) return
    synchronized(entries) {
      if (entries.size <= MAX_ENTRIES) return
      val removeCount = entries.size - (MAX_ENTRIES - EVICTION_BATCH)
      entries.entries
        .sortedBy { it.value.lastTouch }
        .take(removeCount)
        .forEach { entries.remove(it.key) }
    }
  }

  internal fun isEnabled(): Boolean = enabled.get()

  internal fun setEnabled(isEnabled: Boolean) {
    if (enabled.getAndSet(isEnabled) == isEnabled) {
      return
    }

    if (isEnabled) {
      scheduleBroadcast()
    } else {
      handler.removeCallbacksAndMessages(null)
      entries.clear()
    }
  }

  private fun scheduleBroadcast() {
    handler.postDelayed(
      object : Runnable {
        override fun run() {
          if (!enabled.get()) return
          broadcastSnapshot()
          handler.postDelayed(this, BROADCAST_INTERVAL_MS)
        }
      },
      BROADCAST_INTERVAL_MS,
    )
  }

  private fun broadcastSnapshot() {
    val ctx = context ?: return
    val payload = buildSnapshotJson(ctx.packageName)
    val intent =
      Intent(AutoMobileSDK.ACTION_RECOMPOSITION_SNAPSHOT).apply {
        putExtra(AutoMobileSDK.EXTRA_RECOMPOSITION_SNAPSHOT, payload)
        setPackage(SdkConstants.CTRL_PROXY_PACKAGE)
      }
    ctx.sendBroadcast(intent)
  }

  internal fun buildSnapshotJson(applicationId: String): String {
    val entriesArray = JSONArray()
    for (entry in entries.values) {
      entriesArray.put(entry.toJson())
    }

    val snapshot =
      JSONObject()
        .put("timestamp", System.currentTimeMillis())
        .put("applicationId", applicationId)
        .put("entries", entriesArray)

    return snapshot.toString()
  }

  private fun registerControlReceiver(context: Context) {
    controlReceiverRegistrar.register(context) {
      IntentFilter().apply { addAction(AutoMobileSDK.ACTION_RECOMPOSITION_CONTROL) }
    }
  }

  private class Entry(val id: String) {
    /** LRU tick of the last record; read during eviction without the entry lock. */
    @Volatile var lastTouch: Long = 0

    private val rollingAverage = RollingAverage(WINDOW_MS)
    private var totalCount = 0
    private var skipCount = 0
    private var durationTotalMs = 0.0
    private var durationSamples = 0
    private var composableName: String? = null
    private var resourceId: String? = null
    private var testTag: String? = null
    private var parentChain: List<String>? = null
    private var stableAnnotated: Boolean? = null
    private var rememberedCount: Int? = null
    private var likelyCause: String? = null

    @Synchronized
    fun record(
      composableName: String?,
      resourceId: String?,
      testTag: String?,
      parentChain: List<String>?,
      stableAnnotated: Boolean?,
      rememberedCount: Int?,
      likelyCause: String?,
    ) {
      totalCount += 1
      lastTouch = touchSequence.incrementAndGet()
      rollingAverage.record()
      if (composableName != null) this.composableName = composableName
      if (resourceId != null) this.resourceId = resourceId
      if (testTag != null) this.testTag = testTag
      if (parentChain != null) this.parentChain = parentChain
      if (stableAnnotated != null) this.stableAnnotated = stableAnnotated
      if (rememberedCount != null) this.rememberedCount = rememberedCount
      if (likelyCause != null) this.likelyCause = likelyCause
    }

    @Synchronized
    fun recordDuration(durationMs: Double) {
      if (durationMs <= 0) return
      lastTouch = touchSequence.incrementAndGet()
      durationTotalMs += durationMs
      durationSamples += 1
    }

    // Reads the same mutable counters that record()/recordDuration() write under
    // @Synchronized; without it, a snapshot on the handler thread can observe torn
    // or stale counters (e.g. durationTotalMs updated but durationSamples not, #3613).
    @Synchronized
    fun toJson(): JSONObject {
      val json =
        JSONObject()
          .put("id", id)
          .put("total", totalCount)
          .put("skipCount", skipCount)
          .put("rolling1sAverage", rollingAverage.getAverage())

      composableName?.let { json.put("composableName", it) }
      resourceId?.let { json.put("resourceId", it) }
      testTag?.let { json.put("testTag", it) }
      parentChain?.let { json.put("parentChain", JSONArray(it)) }
      stableAnnotated?.let { json.put("stableAnnotated", it) }
      rememberedCount?.let { json.put("rememberedCount", it) }
      likelyCause?.let { json.put("likelyCause", it) }
      if (durationSamples > 0) {
        json.put("durationMs", durationTotalMs / durationSamples)
      }

      return json
    }
  }

  private class RollingAverage(private val windowMs: Long) {
    private val timestamps = ConcurrentLinkedQueue<Long>()

    fun record() {
      val now = System.currentTimeMillis()
      timestamps.add(now)
      prune(now)
    }

    fun getAverage(): Double {
      val now = System.currentTimeMillis()
      prune(now)
      return timestamps.size.toDouble() / (windowMs.toDouble() / 1000.0)
    }

    private fun prune(now: Long) {
      val cutoff = now - windowMs
      while (true) {
        val head = timestamps.peek() ?: break
        if (head >= cutoff) break
        timestamps.poll()
      }
    }
  }
}
