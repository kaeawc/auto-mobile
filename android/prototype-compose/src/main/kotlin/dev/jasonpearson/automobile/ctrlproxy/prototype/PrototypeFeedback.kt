package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeAction
import dev.jasonpearson.automobile.protocol.PrototypeFeedbackEntry
import dev.jasonpearson.automobile.protocol.PrototypePlatformAction
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.prototype.PlatformAvailability
import dev.jasonpearson.automobile.prototype.PlatformCall
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformError
import dev.jasonpearson.automobile.prototype.PlatformErrorCode
import dev.jasonpearson.automobile.prototype.PlatformEvent
import dev.jasonpearson.automobile.prototype.PrototypePlatformModule
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

// Haptic and sound feedback calls (#14329). The modules map a validated call onto a platform
// player; the runtime keeps the verifiable log. Players are interfaces so the mapping, the
// API-level
// fallbacks and the ring bound are testable without a device.

/** The `haptics.perform` effect vocabulary, in the contract's order. */
enum class HapticEffect(val wire: String) {
  CLICK("click"),
  TICK("tick"),
  HEAVY_CLICK("heavyClick"),
  DOUBLE_CLICK("doubleClick"),
  SELECTION("selection"),
  SUCCESS("success"),
  WARNING("warning"),
  ERROR("error"),
  IMPACT_LIGHT("impactLight"),
  IMPACT_MEDIUM("impactMedium"),
  IMPACT_HEAVY("impactHeavy"),
  LONG_PRESS("longPress");

  companion object {
    fun parse(wire: String?): HapticEffect? = entries.firstOrNull { it.wire == wire }
  }
}

/** The closed `sound.play` list; audio asset ids wait for the audio asset type (#14254). */
enum class SoundCue(val wire: String) {
  CLICK("click"),
  SEND("send"),
  RECEIVE("receive"),
  SHUTTER("shutter");

  companion object {
    fun parse(wire: String?): SoundCue? = entries.firstOrNull { it.wire == wire }
  }
}

/** What a player did with a request. */
enum class FeedbackOutcome {
  PLAYED,
  /** A system setting (touch feedback, the ringer) stopped it; logged as `suppressed`. */
  SUPPRESSED,
  /** The hardware or service is absent. */
  UNAVAILABLE,
}

fun interface HapticsPlayer {
  fun perform(effect: HapticEffect): FeedbackOutcome
}

fun interface SoundPlayer {
  /** [volume] is 0-100, or null for the platform default. */
  fun play(cue: SoundCue, volume: Int?): FeedbackOutcome
}

/** The last [capacity] feedback calls of one prototype, oldest first. */
class PrototypeFeedbackLog(private val capacity: Int = MAX_ENTRIES) {
  private val entries = ArrayDeque<PrototypeFeedbackEntry>()

  init {
    require(capacity > 0)
  }

  @Synchronized
  fun record(entry: PrototypeFeedbackEntry) {
    if (entries.size == capacity) entries.removeFirst()
    entries.addLast(entry)
  }

  @Synchronized fun snapshot(): List<PrototypeFeedbackEntry> = entries.toList()

  companion object {
    const val MAX_ENTRIES = 64
  }
}

/** `haptics.perform`. Availability is the player's; the call never needs a runtime permission. */
class HapticsModule(private val player: HapticsPlayer) : PrototypePlatformModule {
  override val name = "haptics"
  override val capability = "prototype_platform_haptics_v1"
  override val events = emptyFlow<PlatformEvent>()
  override val state = MutableStateFlow(JsonObject(emptyMap())).asStateFlow()

  override fun availability() = PlatformAvailability.Ready

  override suspend fun call(call: PlatformCall): PlatformCallResult {
    if (call.call != "haptics.perform") return unsupported(call.call)
    val effect =
      HapticEffect.parse(call.args.string("effect"))
        ?: return invalid("effect must be one of the haptics.perform effects")
    return result(player.perform(effect), "haptics unavailable on this device")
  }

  override fun close() = Unit
}

/** `sound.play`. */
class SoundModule(private val player: SoundPlayer) : PrototypePlatformModule {
  override val name = "sound"
  override val capability = "prototype_platform_sound_v1"
  override val events = emptyFlow<PlatformEvent>()
  override val state = MutableStateFlow(JsonObject(emptyMap())).asStateFlow()

  override fun availability() = PlatformAvailability.Ready

  override suspend fun call(call: PlatformCall): PlatformCallResult {
    if (call.call != "sound.play") return unsupported(call.call)
    val cue =
      SoundCue.parse(call.args.string("sound"))
        ?: return invalid("sound must be click, send, receive or shutter")
    val volume = (call.args["volume"] as? JsonPrimitive)?.intOrNull
    if (volume != null && volume !in 0..100) return invalid("volume must be 0 to 100")
    return result(player.play(cue, volume), "sound unavailable on this device")
  }

  override fun close() = Unit
}

private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

private fun unsupported(call: String) =
  PlatformCallResult.Failure(PlatformError(PlatformErrorCode.UNSUPPORTED, "Unknown call $call"))

private fun invalid(message: String) =
  PlatformCallResult.Failure(PlatformError(PlatformErrorCode.INVALID_ARGS, message))

private fun result(outcome: FeedbackOutcome, unavailable: String): PlatformCallResult =
  when (outcome) {
    FeedbackOutcome.UNAVAILABLE ->
      PlatformCallResult.Failure(PlatformError(PlatformErrorCode.UNAVAILABLE, unavailable))
    else ->
      PlatformCallResult.Success(
        buildJsonObject { put("suppressed", outcome == FeedbackOutcome.SUPPRESSED) },
      )
  }

/** The feedback entry a finished call adds to the log, or null for any other call. */
internal fun feedbackLogEntry(
  call: String,
  args: JsonObject,
  result: PlatformCallResult,
  nodeId: String?,
  timeMs: Long,
): PrototypeFeedbackEntry? {
  val success = result as? PlatformCallResult.Success ?: return null
  val suppressed =
    ((success.value as? JsonObject)?.get("suppressed") as? JsonPrimitive)?.contentOrNull == "true"
  val mark = if (suppressed) true else null
  return when (call) {
    "haptics.perform" ->
      PrototypeFeedbackEntry(
        timeMs,
        effect = args.string("effect") ?: return null,
        nodeId = nodeId,
        suppressed = mark,
      )
    "sound.play" ->
      PrototypeFeedbackEntry(
        timeMs,
        sound = args.string("sound") ?: return null,
        nodeId = nodeId,
        suppressed = mark,
      )
    else -> null
  }
}

private val nodeJson = Json { encodeDefaults = false }

/**
 * The id of the one node whose tap, long-press or double-tap list holds [action], or null when none
 * or several do (a platform handler, an unnamed node, or the same call authored twice).
 */
internal fun owningNodeId(spec: PrototypeSpec, action: PrototypePlatformAction): String? {
  val wanted = nodeJson.encodeToJsonElement(PrototypeAction.serializer(), action)
  val owners = linkedSetOf<String>()
  fun visit(element: JsonElement) {
    when (element) {
      is JsonObject -> {
        val id = (element["id"] as? JsonPrimitive)?.contentOrNull
        val holds =
          listOf("onTap", "onLongPress", "onDoubleTap").any { key ->
            (element[key] as? JsonArray)?.any { it == wanted } == true
          }
        if (id != null && holds) owners += id
        element.values.forEach(::visit)
      }
      is JsonArray -> element.forEach(::visit)
      else -> Unit
    }
  }
  visit(nodeJson.encodeToJsonElement(PrototypeSpec.serializer(), spec))
  return owners.singleOrNull()
}
