package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import dev.jasonpearson.automobile.protocol.PrototypeLocationEventSummary
import dev.jasonpearson.automobile.prototype.*
import kotlin.math.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.selects.select
import kotlinx.serialization.json.*

/** A platform reading. Optional measurements stay absent when the provider did not report them. */
@Suppress("LongParameterList") // One reading carries the contract fields without invented defaults.
data class LocationFix(
  val latitude: Double,
  val longitude: Double,
  val accuracyM: Double,
  val timestampMs: Long,
  val approximate: Boolean = false,
  val altitudeM: Double? = null,
  val speedMps: Double? = null,
  val bearingDeg: Double? = null,
) {
  @Suppress("ComplexCondition") // Each reported field has its own reference reducer range.
  fun valid(): Boolean =
    latitude.inRange(-90.0, 90.0) &&
      longitude.inRange(-180.0, 180.0) &&
      accuracyM.inRange(0.0, Double.MAX_VALUE) &&
      timestampMs in 0..9_007_199_254_740_991L &&
      (altitudeM == null || altitudeM.inRange(-20_000.0, 100_000.0)) &&
      (speedMps == null || speedMps.inRange(0.0, 1000.0)) &&
      (bearingDeg == null || bearingDeg.inRange(0.0, 360.0))

  fun json(): JsonObject = buildJsonObject {
    put("latitude", latitude)
    put("longitude", longitude)
    put("accuracyM", accuracyM)
    put("timestampMs", timestampMs)
    put("approximate", approximate)
    altitudeM?.let { put("altitudeM", it) }
    speedMps?.let { put("speedMps", it) }
    bearingDeg?.let { put("bearingDeg", it) }
  }

  /** A fine grant must not leak a precise reading through an approximate request. */
  fun coarse(): LocationFix =
    copy(
      latitude = round(latitude * 100) / 100,
      longitude = round(longitude * 100) / 100,
      accuracyM = max(accuracyM, 1500.0),
      approximate = true,
      altitudeM = null,
      speedMps = null,
      bearingDeg = null,
    )
}

private fun Double.inRange(min: Double, max: Double) = isFinite() && this in min..max

enum class PrototypeLocationGrant {
  NONE,
  APPROXIMATE,
  PRECISE,
}

enum class PrototypeLocationAccuracy {
  PRECISE,
  APPROXIMATE,
}

/** Permission is read for each operation; implementations propagate cancellation and denial. */
interface PrototypeLocationSource {
  val grant: PrototypeLocationGrant
  val servicesEnabled: StateFlow<Boolean>

  suspend fun current(accuracy: PrototypeLocationAccuracy, maxAgeMs: Long): LocationFix?

  fun updates(
    accuracy: PrototypeLocationAccuracy,
    minIntervalMs: Long,
    minDistanceM: Double,
  ): Flow<LocationFix>

  fun close()
}

/** A controllable source with no Android, clock or process access. */
class FakePrototypeLocationSource : PrototypeLocationSource {
  override var grant = PrototypeLocationGrant.PRECISE
  override val servicesEnabled = MutableStateFlow(true)
  var fix: LocationFix? = null
  var read: suspend (PrototypeLocationAccuracy, Long) -> LocationFix? = { _, _ -> fix }
  val readings = MutableSharedFlow<LocationFix>()
  var closed = false
  var activeSubscriptions = 0
    private set

  override suspend fun current(accuracy: PrototypeLocationAccuracy, maxAgeMs: Long) =
    read(accuracy, maxAgeMs)

  override fun updates(
    accuracy: PrototypeLocationAccuracy,
    minIntervalMs: Long,
    minDistanceM: Double,
  ): Flow<LocationFix> = flow {
    activeSubscriptions++
    try {
      readings.collect { emit(it) }
    } finally {
      activeSubscriptions--
    }
  }

  override fun close() {
    closed = true
  }
}

/** Foreground location subscription policy; defaults keep the most frequent updates at one Hz. */
data class PrototypeLocationConfig(
  val accuracy: PrototypeLocationAccuracy = PrototypeLocationAccuracy.PRECISE,
  val minIntervalMs: Long = 1000,
  val minDistanceM: Double = 0.0,
) {
  companion object {
    fun of(block: JsonObject) =
      PrototypeLocationConfig(
        accuracy(block["accuracy"]),
        block["minIntervalMs"]?.jsonPrimitive?.longOrNull ?: 1000,
        block["minDistanceM"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
      )

    fun accuracy(value: JsonElement?) =
      if ((value as? JsonPrimitive)?.content == "approximate") PrototypeLocationAccuracy.APPROXIMATE
      else PrototypeLocationAccuracy.PRECISE
  }
}

/** LocationManager-backed calls and foreground-only updates; delivered events contain no fix. */
@Suppress("TooManyFunctions") // One subscription state machine owns calls, filtering and teardown.
class PrototypeLocationModule(
  private val source: PrototypeLocationSource,
  private val clock: () -> Long = { System.nanoTime() / 1_000_000 },
  scope: CoroutineScope? = null,
  private val warn: (String) -> Unit = { Log.w("PrototypeLocation", it) },
) : PrototypePlatformModule {
  private val moduleScope by lazy {
    scope ?: CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  }
  override val name = "location"
  override val capability = "prototype_platform_location_v1"
  private val mutableState = MutableStateFlow(buildJsonObject { put("servicesEnabled", false) })
  private val mutableEvents = MutableSharedFlow<PlatformEvent>()
  private var servicesJob: Job? = null
  private var updatesJob: Job? = null
  private var closed = false
  private var config: PrototypeLocationConfig? = null
  // The grant the live subscription was set up under; a later grant re-registers updates.
  private var subscribedGrant: PrototypeLocationGrant? = null
  private val resubscribes = MutableStateFlow(0)
  override val events = mutableEvents.asSharedFlow()
  override val state: StateFlow<JsonObject>
    get() {
      if (!closed && servicesJob == null) {
        publishServices(source.servicesEnabled.value)
        servicesJob =
          moduleScope.launch(start = CoroutineStart.UNDISPATCHED) {
            source.servicesEnabled.collect { publishServices(it) }
          }
      }
      return mutableState.asStateFlow()
    }

  // Calls check permission and services together, preserving the typed disabled reason.
  override fun availability() = PlatformAvailability.Ready

  override suspend fun call(call: PlatformCall): PlatformCallResult {
    if (call.call != "location.request")
      return failure(PlatformErrorCode.UNSUPPORTED, "Unknown location call")
    if (closed) return failure(PlatformErrorCode.UNAVAILABLE, "Location source closed")
    if (source.grant == PrototypeLocationGrant.NONE) return denied()
    if (!source.servicesEnabled.value) return disabled()
    val accuracy = effectiveAccuracy(PrototypeLocationConfig.accuracy(call.args["accuracy"]))
    // A successful permission check proves a grant the update subscription may have missed.
    resubscribeOnGrantChange()
    val reading =
      try {
        currentUnlessDisabled(accuracy, call.args["maxAgeMs"]?.jsonPrimitive?.longOrNull ?: 0)
      } catch (error: SecurityException) {
        warn("Location permission denied: ${error.javaClass.simpleName}")
        return denied()
      }
    if (reading !is Reading.Fix || !source.servicesEnabled.value) return disabled()
    val fix = reading.fix
    if (source.grant == PrototypeLocationGrant.NONE) return denied()
    if (fix == null) return failure(PlatformErrorCode.TIMEOUT, "No current location fix")
    if (!fix.valid()) return failure(PlatformErrorCode.PLATFORM_ERROR, "Invalid location fix")
    val value = normalize(fix, accuracy).json()
    publishFix(value)
    return PlatformCallResult.Success(value)
  }

  /** Pending reads end with `disabled` as soon as services turn off, not at the call timeout. */
  private suspend fun currentUnlessDisabled(
    accuracy: PrototypeLocationAccuracy,
    maxAgeMs: Long,
  ): Reading = coroutineScope {
    val read = async(start = CoroutineStart.UNDISPATCHED) { source.current(accuracy, maxAgeMs) }
    val off = async(start = CoroutineStart.UNDISPATCHED) { source.servicesEnabled.first { !it } }
    try {
      select {
        read.onAwait { Reading.Fix(it) }
        off.onAwait { Reading.Disabled }
      }
    } finally {
      read.cancel()
      off.cancel()
    }
  }

  private sealed interface Reading {
    data class Fix(val fix: LocationFix?) : Reading

    data object Disabled : Reading
  }

  fun startUpdates(config: PrototypeLocationConfig) {
    if (this.config == config && updatesJob?.isActive == true) {
      // Same surface config: keep the subscription unless the grant changed since it started.
      resubscribeOnGrantChange()
      return
    }
    stopUpdates()
    this.config = config
    if (closed) return
    updatesJob =
      moduleScope.launch(start = CoroutineStart.UNDISPATCHED) {
        // Restart on service toggle, releasing the provider while location services are disabled,
        // and on a grant change, registering the provider once permission arrives.
        combine(source.servicesEnabled, resubscribes) { enabled, _ -> enabled }
          .collectLatest { enabled ->
            publishServices(enabled)
            subscribedGrant = source.grant
            if (!enabled || subscribedGrant == PrototypeLocationGrant.NONE) return@collectLatest
            collectUpdates(config)
          }
      }
  }

  private fun resubscribeOnGrantChange() {
    if (updatesJob?.isActive == true && source.grant != subscribedGrant) resubscribes.value++
  }

  private suspend fun collectUpdates(config: PrototypeLocationConfig) {
    val accuracy = effectiveAccuracy(config.accuracy)
    var delivered: LocationFix? = null
    var deliveredAt = 0L
    try {
      source.updates(accuracy, config.minIntervalMs, config.minDistanceM).collect { fix ->
        if (!fix.valid() || source.grant == PrototypeLocationGrant.NONE) return@collect
        val value = normalize(fix, accuracy)
        val now = clock()
        val previous = delivered
        if (
          previous != null &&
            (now - deliveredAt < config.minIntervalMs ||
              distance(previous, value) < config.minDistanceM)
        )
          return@collect
        delivered = value
        deliveredAt = now
        val json = value.json()
        publishFix(json)
        mutableEvents.emit(
          PlatformEvent("location.updated", checkNotNull(PrototypeLocationEventSummary.of(json))),
        )
      }
    } catch (error: SecurityException) {
      warn("Location updates permission denied: ${error.javaClass.simpleName}")
    } catch (error: CancellationException) {
      throw error
    } catch (@Suppress("TooGenericExceptionCaught") error: RuntimeException) {
      // A failing provider must not cancel the renderer's parent scope. Never log a fix.
      warn("Location updates failed: ${error.javaClass.simpleName}")
    }
  }

  fun stopUpdates() {
    updatesJob?.cancel()
    updatesJob = null
    config = null
    subscribedGrant = null
  }

  /** Each shown surface owns its own filters, state and subscription, sharing only the source. */
  internal fun session(scope: CoroutineScope) = PrototypeLocationModule(source, clock, scope, warn)

  internal fun detach() {
    closed = true
    stopUpdates()
    servicesJob?.cancel()
  }

  override fun close() {
    detach()
    source.close()
  }

  private fun effectiveAccuracy(requested: PrototypeLocationAccuracy) =
    if (source.grant == PrototypeLocationGrant.APPROXIMATE) PrototypeLocationAccuracy.APPROXIMATE
    else requested

  private fun normalize(fix: LocationFix, requested: PrototypeLocationAccuracy) =
    if (effectiveAccuracy(requested) == PrototypeLocationAccuracy.APPROXIMATE || fix.approximate)
      fix.coarse()
    else fix

  private fun publishFix(fix: JsonObject) {
    mutableState.update { JsonObject(it + ("current" to fix)) }
  }

  private fun publishServices(enabled: Boolean) {
    mutableState.update { JsonObject(it + ("servicesEnabled" to JsonPrimitive(enabled))) }
  }

  private fun denied() = failure(PlatformErrorCode.PERMISSION_DENIED, "Location permission denied")

  private fun disabled() =
    failure(PlatformErrorCode.UNAVAILABLE, "Location services disabled", "disabled")

  private fun failure(code: PlatformErrorCode, message: String, reason: String? = null) =
    PlatformCallResult.Failure(PlatformError(code, message, reason))

  private fun distance(a: LocationFix, b: LocationFix): Double {
    val radians = PI / 180
    val lat = sin((b.latitude - a.latitude) * radians / 2).pow(2)
    val lon = sin((b.longitude - a.longitude) * radians / 2).pow(2)
    val arc = lat + cos(a.latitude * radians) * cos(b.latitude * radians) * lon
    return 6_371_000 * 2 * asin(sqrt(arc.coerceIn(0.0, 1.0)))
  }
}
