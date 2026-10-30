package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.PlatformCall
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformErrorCode
import dev.jasonpearson.automobile.prototype.PrototypePlatform as Platform
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Haptic and sound feedback (#14329): the modules, the log ring and the runtime wiring. */
@OptIn(ExperimentalCoroutinesApi::class)
class PrototypeFeedbackTest {
  private class FakeHaptics(var outcome: FeedbackOutcome = FeedbackOutcome.PLAYED) : HapticsPlayer {
    val performed = mutableListOf<HapticEffect>()

    override fun perform(effect: HapticEffect): FeedbackOutcome {
      performed += effect
      return outcome
    }
  }

  private class FakeSound(var outcome: FeedbackOutcome = FeedbackOutcome.PLAYED) : SoundPlayer {
    val played = mutableListOf<Pair<SoundCue, Int?>>()

    override fun play(cue: SoundCue, volume: Int?): FeedbackOutcome {
      played += cue to volume
      return outcome
    }
  }

  private fun args(vararg pairs: Pair<String, JsonElement>) = JsonObject(mapOf(*pairs))

  private fun call(name: String, vararg pairs: Pair<String, JsonElement>) =
    PlatformCall("id", name, args(*pairs))

  @Test
  fun `every contract effect and sound maps to a player request`() = runTest {
    val haptics = FakeHaptics()
    val module = HapticsModule(haptics)
    for (effect in HapticEffect.entries) {
      val result = module.call(call("haptics.perform", "effect" to JsonPrimitive(effect.wire)))
      assertTrue(effect.wire, result is PlatformCallResult.Success)
    }
    assertEquals(HapticEffect.entries.toList(), haptics.performed)
    assertEquals(
      listOf(
        "click",
        "tick",
        "heavyClick",
        "doubleClick",
        "selection",
        "success",
        "warning",
        "error",
        "impactLight",
        "impactMedium",
        "impactHeavy",
        "longPress",
      ),
      HapticEffect.entries.map { it.wire },
    )
    val sound = FakeSound()
    val soundModule = SoundModule(sound)
    for (cue in SoundCue.entries) {
      soundModule.call(call("sound.play", "sound" to JsonPrimitive(cue.wire)))
    }
    soundModule.call(
      call("sound.play", "sound" to JsonPrimitive("send"), "volume" to JsonPrimitive(80)),
    )
    assertEquals(
      SoundCue.entries.map { it to null } + (SoundCue.SEND to 80),
      sound.played,
    )
  }

  @Test
  fun `bad arguments fail typed and never reach a player`() = runTest {
    val haptics = FakeHaptics()
    val sound = FakeSound()
    val badEffect =
      HapticsModule(haptics).call(call("haptics.perform", "effect" to JsonPrimitive("buzz")))
    val badSound = SoundModule(sound).call(call("sound.play", "sound" to JsonPrimitive("cheer")))
    val badVolume =
      SoundModule(sound)
        .call(call("sound.play", "sound" to JsonPrimitive("click"), "volume" to JsonPrimitive(101)))
    val unknown = HapticsModule(haptics).call(call("haptics.vibrate"))
    for (failure in listOf(badEffect, badSound, badVolume)) {
      assertEquals(
        PlatformErrorCode.INVALID_ARGS,
        (failure as PlatformCallResult.Failure).error.code,
      )
    }
    assertEquals(PlatformErrorCode.UNSUPPORTED, (unknown as PlatformCallResult.Failure).error.code)
    assertTrue(haptics.performed.isEmpty() && sound.played.isEmpty())
  }

  @Test
  fun `a missing vibrator is unavailable and a system setting suppresses`() = runTest {
    val effect = "effect" to JsonPrimitive("click")
    val missing = HapticsModule(FakeHaptics(FeedbackOutcome.UNAVAILABLE))
    assertEquals(
      PlatformErrorCode.UNAVAILABLE,
      (missing.call(call("haptics.perform", effect)) as PlatformCallResult.Failure).error.code,
    )
    val suppressed = HapticsModule(FakeHaptics(FeedbackOutcome.SUPPRESSED))
    val result = suppressed.call(call("haptics.perform", effect)) as PlatformCallResult.Success
    assertEquals(JsonPrimitive(true), (result.value as JsonObject)["suppressed"])
  }

  @Test
  fun `the ring keeps the newest 64 entries oldest first`() {
    val log = PrototypeFeedbackLog()
    repeat(PrototypeFeedbackLog.MAX_ENTRIES + 5) {
      log.record(PrototypeFeedbackEntry(it.toLong(), effect = "tick"))
    }
    val kept = log.snapshot()
    assertEquals(64, kept.size)
    assertEquals(5L, kept.first().timeMs)
    assertEquals(68L, kept.last().timeMs)
    assertTrue(
      PrototypeFeedbackLog(2)
        .also { l -> repeat(3) { l.record(PrototypeFeedbackEntry(it.toLong())) } }
        .snapshot()
        .map { it.timeMs } == listOf(1L, 2L),
    )
  }

  private fun feedbackSpec() =
    PrototypeSpec(
      "feedback",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root =
        PrototypeColumnNode(
          children =
            listOf(
              PrototypeButtonNode(
                id = "like",
                label = "Like",
                onTap =
                  listOf(
                    PrototypePlatformAction(
                      "haptics.perform",
                      mapOf("effect" to args("value" to JsonPrimitive("selection"))),
                    ),
                  ),
              ),
              PrototypeButtonNode(
                id = "send",
                label = "Send",
                onTap =
                  listOf(
                    PrototypePlatformAction(
                      "sound.play",
                      mapOf(
                        "sound" to args("value" to JsonPrimitive("send")),
                        "volume" to args("value" to JsonPrimitive(80)),
                      ),
                    ),
                  ),
              ),
            ),
        ),
      requires = PrototypeRequires(platform = listOf("haptics", "sound")),
    )

  private fun TestScope.runtime(haptics: HapticsPlayer, sound: SoundPlayer): PrototypeRuntime {
    var id = 0
    var seq = 0L
    val lock = Mutex()
    return PrototypeRuntime(
        feedbackSpec(),
        sink = {},
        clock = { 1_000L + testScheduler.currentTime },
        nextSequence = { ++seq },
        requestScope = backgroundScope,
        exclusively = { lock.withLock { it() } },
        newRequestId = { "call-${++id}" },
        platform = Platform(listOf(HapticsModule(haptics), SoundModule(sound))),
        platformLimiter = PrototypeRequestLimiter(PrototypePlatformDispatcher.MAX_IN_FLIGHT),
        warn = { error(it) },
      )
      .also { it.startPlatformModules() }
  }

  @Test
  fun `a tap logs the call with its node, the time and the suppressed flag`() = runTest {
    val haptics = FakeHaptics()
    val sound = FakeSound(FeedbackOutcome.SUPPRESSED)
    val runtime = runtime(haptics, sound)
    val column = runtime.current.spec.root as PrototypeColumnNode
    for (child in column.children) {
      runtime.handle(PrototypeInteraction.Tap((child as PrototypeButtonNode).onTap.orEmpty()))
    }
    runCurrent()
    assertEquals(
      listOf(
        PrototypeFeedbackEntry(1_000L, effect = "selection", nodeId = "like"),
        PrototypeFeedbackEntry(1_000L, sound = "send", nodeId = "send", suppressed = true),
      ),
      runtime.feedbackLog.snapshot(),
    )
    assertEquals(listOf(SoundCue.SEND to 80), sound.played)
  }

  @Test
  fun `a failed call is not logged and a platform handler has no node`() = runTest {
    val runtime = runtime(FakeHaptics(FeedbackOutcome.UNAVAILABLE), FakeSound())
    val like = (runtime.current.spec.root as PrototypeColumnNode).children[0] as PrototypeButtonNode
    runtime.handle(PrototypeInteraction.Tap(like.onTap.orEmpty()))
    runCurrent()
    assertTrue(runtime.feedbackLog.snapshot().isEmpty())
    val orphan =
      PrototypePlatformAction(
        "haptics.perform",
        mapOf("effect" to args("value" to JsonPrimitive("tick"))),
      )
    assertNull(owningNodeId(runtime.current.spec, orphan))
    assertEquals(
      "like",
      owningNodeId(runtime.current.spec, like.onTap!!.single() as PrototypePlatformAction),
    )
  }
}
