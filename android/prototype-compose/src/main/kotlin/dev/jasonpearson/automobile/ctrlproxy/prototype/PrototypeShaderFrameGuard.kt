package dev.jasonpearson.automobile.ctrlproxy.prototype

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Frame-clock sampling; gaps discard one interval, never accumulated budget evidence. */
@InternalAutoMobilePrototypeApi
class PrototypeShaderFrameGuard(
  private val clockNanos: () -> Long = System::nanoTime,
  private val budgetNanos: Long = 24_000_000L,
  private val consecutiveLimit: Int = 8,
  private val onFailure: (String) -> Unit = {},
) {
  init {
    require(budgetNanos > 0 && consecutiveLimit > 0)
  }

  @Volatile
  var disabledReason: String? = null
    private set

  private var previousNanos = 0L
  private var sampled = false
  private var overBudget = 0
  private val window = BooleanArray(60)
  private var windowIndex = 0
  private var windowCount = 0
  private var windowOverBudget = 0

  fun frame(nowNanos: Long = clockNanos()): Boolean {
    if (disabledReason != null) return false
    if (!sampled) {
      previousNanos = nowNanos
      sampled = true
      return true
    }
    if (nowNanos <= previousNanos) return true
    val slow = nowNanos - previousNanos > budgetNanos
    previousNanos = nowNanos
    overBudget = if (slow) overBudget + 1 else 0
    if (window[windowIndex]) windowOverBudget--
    window[windowIndex] = slow
    if (slow) windowOverBudget++
    windowIndex = (windowIndex + 1) % window.size
    windowCount = (windowCount + 1).coerceAtMost(window.size)
    if (overBudget >= consecutiveLimit || (windowCount == window.size && windowOverBudget > 30)) {
      disable("frame budget exceeded while shaders were active")
    }
    return disabledReason == null
  }

  fun pause() {
    sampled = false
  }

  fun disable(reason: String) {
    if (disabledReason == null) {
      disabledReason = boundedPrototypeShaderError(reason)
      onFailure(checkNotNull(disabledReason))
    }
  }
}

/** One frame-interval signal per prototype; node guards only handle synchronous failures. */
@InternalAutoMobilePrototypeApi
class PrototypeShaderSession {
  class Registration
  internal constructor(
    val id: Long,
    val guard: PrototypeShaderFrameGuard,
  )

  private val guards = mutableMapOf<Long, Registration>()
  private val active = mutableSetOf<Long>()
  private val recordedFailures = linkedMapOf<String, String>()
  private var omittedFailures = 0L
  private var nextId = 0L
  private var visible = false
  private val samplers = linkedMapOf<Any, Boolean>()
  private val mutableSamplingOwner = MutableStateFlow<Any?>(null)
  val samplingOwner = mutableSamplingOwner.asStateFlow()
  private val budget = PrototypeShaderFrameGuard(onFailure = { changed() })
  private val mutableSampling = MutableStateFlow(false)
  val sampling = mutableSampling.asStateFlow()
  private val mutableRevision = MutableStateFlow(0L)
  val revision = mutableRevision.asStateFlow()

  val disabledReason: String?
    get() = budget.disabledReason

  @Synchronized
  fun register(identity: String): Registration {
    val id = ++nextId
    val guard =
      PrototypeShaderFrameGuard(onFailure = { reason -> record("$identity [$id]", reason) })
    return Registration(id, guard).also { guards[id] = it }
  }

  @Synchronized
  fun unregister(registration: Registration) {
    guards.remove(registration.id)
    active.remove(registration.id)
    changed()
  }

  @Synchronized
  fun setActive(registration: Registration, value: Boolean) {
    if (
      value && guards[registration.id] === registration && registration.guard.disabledReason == null
    ) {
      active.add(registration.id)
    } else active.remove(registration.id)
    changed()
  }

  @Synchronized
  fun setVisible(value: Boolean, owner: Any? = null) {
    if (owner == null) visible = value else samplers[owner] = value
    changed()
  }

  @Synchronized
  fun removeSampler(owner: Any) {
    samplers.remove(owner)
    changed()
  }

  @Synchronized
  fun frame(nowNanos: Long, owner: Any? = null): Boolean =
    (owner == null || mutableSamplingOwner.value === owner) &&
      mutableSampling.value &&
      budget.frame(nowNanos)

  @Synchronized
  fun pause(owner: Any? = null) {
    if (owner == null || mutableSamplingOwner.value === owner) budget.pause()
  }

  @Synchronized
  fun failures(): Map<String, String> = buildMap {
    disabledReason?.let { put("prototype", it) }
    putAll(recordedFailures)
    if (omittedFailures > 0) put("+$omittedFailures more", "Additional shader failures omitted")
  }

  internal val registeredCount: Int
    @Synchronized get() = guards.size

  @Synchronized
  private fun record(identity: String, reason: String) {
    // Keep the first failures, bounded independently of the number of nodes ever composed.
    if (recordedFailures.size < 64) recordedFailures[identity] = reason else omittedFailures++
    changed()
  }

  private fun changed() {
    // Replacement windows can overlap. Only the most recently attached root owns the signal;
    // removing it restores an older root if the replacement failed before retiring that window.
    val windowVisible = samplers.values.lastOrNull() ?: visible
    val samplingNow =
      windowVisible &&
        disabledReason == null &&
        active.any { guards[it]?.guard?.disabledReason == null }
    val nextOwner = if (samplingNow) samplers.keys.lastOrNull() else null
    if (!samplingNow || mutableSamplingOwner.value !== nextOwner) budget.pause()
    mutableSampling.value = samplingNow
    mutableSamplingOwner.value = nextOwner
    mutableRevision.value++
  }
}
