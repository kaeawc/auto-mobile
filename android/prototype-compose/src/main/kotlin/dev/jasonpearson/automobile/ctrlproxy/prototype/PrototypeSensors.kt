package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import dev.jasonpearson.automobile.prototype.*
import kotlin.math.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*

enum class PrototypeSensor(val blockKey: String, val keys: Set<String>) {
  ORIENTATION("orientation", setOf("pitchDeg", "rollDeg", "headingDeg")),
  LIGHT("light", setOf("lightLux")),
  PROXIMITY("proximity", setOf("proximityNear")),
  STEPS("steps", setOf("steps")),
  SHAKE("shake", emptySet()),
}

/** Raw readings use monotonic milliseconds; step readings are the device's cumulative counter. */
sealed interface PrototypeSensorSample {
  val timestampMs: Long

  data class Values(override val timestampMs: Long, val values: Map<String, Double>) :
    PrototypeSensorSample

  data class Proximity(override val timestampMs: Long, val near: Boolean) : PrototypeSensorSample

  data class Acceleration(
    override val timestampMs: Long,
    val x: Double,
    val y: Double,
    val z: Double,
  ) : PrototypeSensorSample
}

/** Presence and permission are read at each start; collecting a flow owns one registration. */
interface PrototypeSensorSource {
  fun hasSensor(sensor: PrototypeSensor): Boolean

  val stepsGranted: Boolean

  fun samples(sensor: PrototypeSensor, rateHz: Int): Flow<PrototypeSensorSample>

  fun close()
}

class FakePrototypeSensorSource : PrototypeSensorSource {
  val present = PrototypeSensor.entries.toMutableSet()
  override var stepsGranted = true
  val readings = PrototypeSensor.entries.associateWith { MutableSharedFlow<PrototypeSensorSample>() }
  val subscriptions = mutableListOf<Pair<PrototypeSensor, Int>>()
  var activeSubscriptions = 0
    private set
  var closed = false
    private set

  override fun hasSensor(sensor: PrototypeSensor) = sensor in present

  override fun samples(sensor: PrototypeSensor, rateHz: Int): Flow<PrototypeSensorSample> = flow {
    subscriptions += sensor to rateHz
    activeSubscriptions++
    try {
      readings.getValue(sensor).collect { emit(it) }
    } finally {
      activeSubscriptions--
    }
  }

  override fun close() {
    closed = true
  }
}

/** Math.round rounds ties toward positive infinity, unlike Kotlin's ties-to-even round. */
internal fun roundPrototypeSensorValue(key: String, value: Double): Double {
  val whole = floor(value + 0.5)
  return when (key) {
    "headingDeg" -> ((whole % 360) + 360) % 360
    "pitchDeg", "rollDeg" -> whole.coerceIn(-180.0, 180.0)
    else -> max(0.0, whole)
  }
}

/** Streaming port of prototypeSensorReference.ts; each key remembers its last emitted write. */
internal class PrototypeSensorFilter(private val rateHz: Int) {
  private val writes = mutableMapOf<String, Pair<Long, JsonPrimitive>>()

  init {
    require(rateHz in 1..30)
  }

  fun write(key: String, timestampMs: Long, value: JsonPrimitive): Boolean {
    val last = writes[key]
    if (last != null && (last.second == value || timestampMs - last.first < 1000.0 / rateHz))
      return false
    writes[key] = timestampMs to value
    return true
  }
}

internal class PrototypeShakeDetector {
  private var last: Long? = null

  fun shake(sample: PrototypeSensorSample.Acceleration): Boolean {
    val g = hypot(hypot(sample.x, sample.y), sample.z) / 9.80665
    if (g < 2.7 || g.isNaN() || last?.let { sample.timestampMs - it < 1000 } == true) return false
    last = sample.timestampMs
    return true
  }
}

/** Each shown surface owns its state, filters and subscriptions, sharing only the source. */
class PrototypeSensorsModule(
  private val source: PrototypeSensorSource,
  scope: CoroutineScope? = null,
  private val warn: (String) -> Unit = { Log.w("PrototypeSensors", it) },
) : PrototypePlatformModule {
  private val moduleScope by lazy {
    scope ?: CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  }
  override val name = "sensors"
  override val capability = "prototype_platform_sensors_v1"
  private val mutableState = MutableStateFlow(JsonObject(emptyMap()))
  private val mutableEvents = MutableSharedFlow<PlatformEvent>()
  override val state = mutableState.asStateFlow()
  override val events = mutableEvents.asSharedFlow()
  private var job: Job? = null
  private var config: JsonObject? = null
  private var subscribed = emptySet<PrototypeSensor>()
  private var closed = false

  override fun availability() = PlatformAvailability.Ready

  override suspend fun call(call: PlatformCall) =
    PlatformCallResult.Failure(PlatformError(PlatformErrorCode.UNSUPPORTED, "Sensors has no calls"))

  fun startSensors(block: JsonObject) {
    if (closed) return
    val sensors = PrototypeSensor.entries.filterTo(mutableSetOf()) {
      it.blockKey in block && source.hasSensor(it) && (it != PrototypeSensor.STEPS || source.stepsGranted)
    }
    if (config == block && subscribed == sensors && job?.isActive == true) return
    stopSensors()
    config = block
    subscribed = sensors
    job = moduleScope.launch(start = CoroutineStart.UNDISPATCHED) {
      sensors.forEach { sensor ->
        val rate = (block[sensor.blockKey] as? JsonObject)?.get("rateHz")?.jsonPrimitive?.int ?: 1
        launch(start = CoroutineStart.UNDISPATCHED) { collectSensor(sensor, rate) }
      }
      awaitCancellation()
    }
  }

  private suspend fun collectSensor(sensor: PrototypeSensor, rateHz: Int) {
    val filter = PrototypeSensorFilter(rateHz)
    val shakes = PrototypeShakeDetector()
    var initialSteps: Double? = null
    try {
      source.samples(sensor, rateHz).collect { sample ->
        when (sample) {
          is PrototypeSensorSample.Acceleration ->
            if (sensor == PrototypeSensor.SHAKE && shakes.shake(sample))
              mutableEvents.emit(PlatformEvent("sensors.shake", JsonObject(emptyMap())))
          is PrototypeSensorSample.Proximity ->
            if (sensor == PrototypeSensor.PROXIMITY)
              publish(filter, "proximityNear", sample.timestampMs, JsonPrimitive(sample.near))
          is PrototypeSensorSample.Values -> sample.values.forEach { (key, raw) ->
            if (key !in sensor.keys || !raw.isFinite()) return@forEach
            val value = if (sensor == PrototypeSensor.STEPS) {
              if (initialSteps == null) initialSteps = raw
              raw - checkNotNull(initialSteps)
            } else raw
            publish(filter, key, sample.timestampMs, JsonPrimitive(roundPrototypeSensorValue(key, value).toLong()))
          }
        }
      }
    } catch (error: CancellationException) {
      throw error
    } catch (@Suppress("TooGenericExceptionCaught") error: RuntimeException) {
      // An unavailable or revoked sensor must not cancel sibling sensors or the renderer.
      warn("Sensor ${sensor.blockKey} failed: ${error.javaClass.simpleName}")
    }
  }

  private fun publish(filter: PrototypeSensorFilter, key: String, at: Long, value: JsonPrimitive) {
    if (filter.write(key, at, value)) mutableState.update { JsonObject(it + (key to value)) }
  }

  fun stopSensors() {
    job?.cancel()
    job = null
    config = null
    subscribed = emptySet()
    mutableState.value = JsonObject(emptyMap())
  }

  internal fun session(scope: CoroutineScope) = PrototypeSensorsModule(source, scope, warn)

  internal fun detach() {
    closed = true
    stopSensors()
  }

  override fun close() {
    detach()
    source.close()
  }
}
