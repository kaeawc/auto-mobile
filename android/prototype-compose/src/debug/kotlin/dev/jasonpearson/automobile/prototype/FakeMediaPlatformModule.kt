package dev.jasonpearson.automobile.prototype

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypePerRuntimeModule
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypePlatformModeSource
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeSpecAwareModule
import dev.jasonpearson.automobile.protocol.PrototypeFakeMediaEngine
import dev.jasonpearson.automobile.protocol.PrototypePlatformReport
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * The `media` module debug builds carry (#14257), absent from release artifacts. Players run on the
 * deterministic [PrototypeFakeMediaEngine], so a host can drive `media.*` calls and `prototype
 * simulate` media events before a real player exists. Nothing decodes: every player loads paused at
 * 0 with a fixed [FAKE_DURATION_MS] length, and time moves only through a simulated event's
 * `advanceMs`.
 *
 * The registered value is a template; each runtime gets its own [Session], loaded with its spec's
 * `media.players`, so two shown prototypes never share a player.
 */
class FakeMediaPlatformModule :
  PrototypePlatformModule, PrototypePlatformModeSource, PrototypePerRuntimeModule {
  override val name = NAME
  override val capability = CAPABILITY
  override val platformMode = PrototypePlatformReport.Mode.FAKE

  override fun availability() = PlatformAvailability.Ready

  override val events = emptyFlow<PlatformEvent>()
  override val state = MutableStateFlow(JsonObject(emptyMap())).asStateFlow()

  override suspend fun call(call: PlatformCall): PlatformCallResult =
    failure(PlatformErrorCode.UNAVAILABLE, "media calls run on a prototype runtime's session")

  override fun session(scope: CoroutineScope): PrototypePlatformModule = Session()

  override fun close() = Unit

  /** One runtime's players. Engine access is serialized: calls and simulation may race. */
  class Session : PrototypePlatformModule, PrototypePlatformModeSource, PrototypeSpecAwareModule {
    override val name = NAME
    override val capability = CAPABILITY
    override val platformMode = PrototypePlatformReport.Mode.FAKE
    override val supportsSimulation = true

    override fun availability() = PlatformAvailability.Ready

    private val lock = Any()
    private val engine = PrototypeFakeMediaEngine()
    /** Engine events already turned into platform events (or swallowed by a simulation). */
    private var reported = 0
    private val captions = mutableMapOf<String, String>()
    private val mutableEvents = MutableSharedFlow<PlatformEvent>(extraBufferCapacity = EVENT_BUFFER)
    override val events = mutableEvents.asSharedFlow()
    private val mutableState = MutableStateFlow(JsonObject(emptyMap()))
    override val state = mutableState.asStateFlow()

    /** Loads the spec's players that are new and releases the ones it no longer declares. */
    override fun configure(spec: PrototypeSpec) {
      val declared = (spec.media?.get("players") as? JsonObject).orEmpty()
      synchronized(lock) {
        for (id in engine.snapshot().keys - declared.keys) {
          engine.release(id)
          captions.remove(id)
        }
        for ((id, player) in declared) {
          if (id in engine.snapshot()) continue
          val loop = ((player as? JsonObject)?.get("loop") as? JsonPrimitive)?.booleanOrNull
          engine.load(id, FAKE_DURATION_MS, loop == true)
        }
        reported = engine.events.size
        publish()
      }
    }

    override suspend fun call(call: PlatformCall): PlatformCallResult {
      val player = call.args.text("player") ?: return invalid("media calls require player")
      val (result, emitted) = synchronized(lock) { apply(call.call, player, call.args) to drain() }
      emitted.forEach { mutableEvents.tryEmit(it) }
      return result
    }

    /**
     * `prototype simulate` of `media.statusChanged | ended | error {player, status?, code?,
     * advanceMs?}`. State changes here and the runtime delivers the one simulated event itself, so
     * the engine's own events for this step are not emitted.
     */
    override suspend fun simulate(event: PlatformEvent): Boolean =
      synchronized(lock) {
        val player = event.data.text("player") ?: return@synchronized false
        val request =
          PrototypeFakeMediaEngine.SimRequest(
            event = event.name,
            player = player,
            status = event.data.text("status"),
            code = event.data.text("code"),
            advanceMs = (event.data["advanceMs"] as? JsonPrimitive)?.longOrNull,
          )
        val failure = engine.simulate(request)
        reported = engine.events.size
        publish()
        failure == null
      }

    private fun apply(call: String, player: String, args: JsonObject): PlatformCallResult {
      val state = engine.snapshot()[player] ?: return invalid("unknown_player: $player")
      val result =
        FakeMediaCalls.playback(engine, call, player, state)
          ?: FakeMediaCalls.seek(engine, call, player, state, args)
          ?: FakeMediaCalls.setting(captions, call, player, args)
      publish()
      return result
    }

    /** Engine events since the last drain, as platform events. */
    private fun drain(): List<PlatformEvent> {
      val events = engine.events
      val fresh = events.drop(reported)
      reported = events.size
      return fresh.map { PlatformEvent(it.name, it.payload.toJson()) }
    }

    /** `/platform/media`: `{players: {<id>: {playing, positionMs, …}}}`. */
    private fun publish() {
      mutableState.value = buildJsonObject {
        put(
          "players",
          buildJsonObject {
            for ((id, player) in engine.snapshot()) {
              put(
                id,
                buildJsonObject {
                  put("playing", player.playing)
                  put("positionMs", player.positionMs)
                  put("durationMs", player.durationMs)
                  put("buffering", player.buffering)
                  put("status", player.status)
                  player.error?.let { put("error", it) }
                  put("captionTrack", captions[id] ?: "")
                },
              )
            }
          },
        )
      }
    }

    override fun close() = Unit
  }

  companion object {
    const val NAME = "media"
    const val CAPABILITY = "prototype_platform_media_v1"

    /** Every fake player's length, so `advanceMs` can play it to its end. */
    const val FAKE_DURATION_MS = 60_000L
    private const val EVENT_BUFFER = 64

    private fun failure(code: PlatformErrorCode, message: String) =
      PlatformCallResult.Failure(PlatformError(code, message))

    private fun invalid(message: String) = failure(PlatformErrorCode.INVALID_ARGS, message)

    private fun JsonObject.text(key: String): String? =
      (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    private fun Map<String, Any>.toJson(): JsonObject =
      JsonObject(mapValues { (_, value) -> value.toJsonElement() })

    private fun Any.toJsonElement(): JsonElement =
      when (this) {
        is Boolean -> JsonPrimitive(this)
        is Number -> JsonPrimitive(this)
        else -> JsonPrimitive(toString())
      }
  }
}

/** The fake player's `media.*` calls, kept apart so the session stays a thin locked shell. */
private object FakeMediaCalls {
  private val SUCCESS = PlatformCallResult.Success(JsonObject(emptyMap()))

  /** `play`, `pause`, `toggle` and `stop`, or null for any other call. */
  fun playback(
    engine: PrototypeFakeMediaEngine,
    call: String,
    player: String,
    state: PrototypeFakeMediaEngine.State,
  ): PlatformCallResult? =
    when (call) {
      "media.play" -> engine.play(player)
      "media.pause" -> engine.pause(player)
      "media.toggle" -> if (state.playing) engine.pause(player) else engine.play(player)
      "media.stop" -> engine.pause(player) ?: engine.seek(player, 0)
      else -> return null
    }.toResult()

  /** `seek` and `seekBy`, or null for any other call. */
  fun seek(
    engine: PrototypeFakeMediaEngine,
    call: String,
    player: String,
    state: PrototypeFakeMediaEngine.State,
    args: JsonObject,
  ): PlatformCallResult? {
    val target =
      when (call) {
        "media.seek" -> args.long("positionMs") ?: return missing("positionMs")
        "media.seekBy" -> state.positionMs + (args.long("deltaMs") ?: return missing("deltaMs"))
        else -> return null
      }
    return engine.seek(player, target).toResult()
  }

  fun setting(
    captions: MutableMap<String, String>,
    call: String,
    player: String,
    args: JsonObject,
  ): PlatformCallResult =
    when (call) {
      "media.setCaptions" -> {
        val track = args.text("track") ?: return missing("track")
        captions[player] = track
        SUCCESS
      }
      // Accepted so specs exercise them; the fake has no volume, mute, loop or rate output.
      "media.setVolume",
      "media.setMuted",
      "media.setLoop",
      "media.setRate" -> SUCCESS
      else ->
        PlatformCallResult.Failure(
          PlatformError(PlatformErrorCode.UNSUPPORTED, "$call is not a media call here"),
        )
    }

  private fun missing(arg: String) =
    PlatformCallResult.Failure(
      PlatformError(PlatformErrorCode.INVALID_ARGS, "media calls require $arg"),
    )

  private fun PrototypeFakeMediaEngine.Failure?.toResult(): PlatformCallResult =
    this?.let {
      PlatformCallResult.Failure(PlatformError(PlatformErrorCode.INVALID_ARGS, it.code))
    } ?: SUCCESS

  private fun JsonObject.text(key: String): String? =
    (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

  private fun JsonObject.long(key: String): Long? = (get(key) as? JsonPrimitive)?.longOrNull
}
