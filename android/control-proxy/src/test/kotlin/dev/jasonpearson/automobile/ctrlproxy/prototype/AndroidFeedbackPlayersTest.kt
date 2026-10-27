package dev.jasonpearson.automobile.ctrlproxy.prototype

import org.junit.Assert.*
import org.junit.Test

/** The Android mapping of haptic and sound feedback (#14329), against fake gateways. */
class AndroidFeedbackPlayersTest {
  private class FakeVibrator(
    override var available: Boolean = true,
    override var touchFeedbackEnabled: Boolean = true,
  ) : VibratorGateway {
    val plans = mutableListOf<HapticPlan>()

    override fun vibrate(plan: HapticPlan) {
      plans += plan
    }
  }

  private class FakeAudio(
    override var ringerNormal: Boolean = true,
    override var touchSoundsEnabled: Boolean = true,
  ) : AudioGateway {
    val events = mutableListOf<String>()

    override fun playClick(volumePercent: Int?) {
      events += "click:$volumePercent"
    }

    override fun playShutter() {
      events += "shutter"
    }

    override fun playTone(toneId: Int, volumePercent: Int?) {
      events += "tone:$toneId:$volumePercent"
    }
  }

  @Test
  fun `API 29 and up maps every effect to a predefined effect or the error waveform`() {
    val predefined = HapticEffect.entries.associateWith { hapticPlan(it, 34) }
    assertEquals(HapticPlan.Predefined(VibrationEffectIds.CLICK), predefined[HapticEffect.CLICK])
    assertEquals(HapticPlan.Predefined(VibrationEffectIds.TICK), predefined[HapticEffect.SELECTION])
    assertEquals(
      HapticPlan.Predefined(VibrationEffectIds.HEAVY_CLICK),
      predefined[HapticEffect.IMPACT_HEAVY],
    )
    assertEquals(
      HapticPlan.Predefined(VibrationEffectIds.DOUBLE_CLICK),
      predefined[HapticEffect.SUCCESS],
    )
    assertTrue(predefined.getValue(HapticEffect.ERROR) is HapticPlan.Waveform)
    assertEquals(
      listOf(HapticEffect.ERROR),
      predefined.filterValues { it is HapticPlan.Waveform }.keys.toList(),
    )
  }

  @Test
  fun `below API 29 every effect is a one shot or waveform with a valid amplitude`() {
    for (effect in HapticEffect.entries) {
      when (val plan = hapticPlan(effect, 28)) {
        is HapticPlan.OneShot -> {
          assertTrue(plan.durationMs > 0)
          assertTrue(plan.amplitude in 1..255)
        }
        is HapticPlan.Waveform -> assertEquals(plan.timings.size, plan.amplitudes.size)
        is HapticPlan.Predefined -> fail("predefined effects need API 29: $effect")
      }
    }
    assertTrue(hapticPlan(HapticEffect.IMPACT_LIGHT, 28) is HapticPlan.OneShot)
    assertTrue(hapticPlan(HapticEffect.SUCCESS, 28) is HapticPlan.Waveform)
  }

  @Test
  fun `the vibrator is used only when present and touch feedback is on`() {
    val vibrator = FakeVibrator()
    val player = AndroidHapticsPlayer(vibrator, sdkInt = 34)
    assertEquals(FeedbackOutcome.PLAYED, player.perform(HapticEffect.CLICK))
    assertEquals(
      listOf<HapticPlan>(HapticPlan.Predefined(VibrationEffectIds.CLICK)),
      vibrator.plans,
    )
    vibrator.touchFeedbackEnabled = false
    assertEquals(FeedbackOutcome.SUPPRESSED, player.perform(HapticEffect.CLICK))
    vibrator.available = false
    assertEquals(FeedbackOutcome.UNAVAILABLE, player.perform(HapticEffect.CLICK))
    assertEquals(1, vibrator.plans.size)
  }

  @Test
  fun `each cue has its own production path and the ringer and touch sounds suppress`() {
    val audio = FakeAudio()
    val player = AndroidSoundPlayer(audio)
    for (cue in SoundCue.entries) player.play(cue, 40)
    assertEquals(
      listOf("click:40", "tone:${ToneIds.ACK}:40", "tone:${ToneIds.PROMPT}:40", "shutter"),
      audio.events,
    )
    audio.events.clear()
    audio.touchSoundsEnabled = false
    assertEquals(FeedbackOutcome.SUPPRESSED, player.play(SoundCue.CLICK, null))
    assertEquals(FeedbackOutcome.PLAYED, player.play(SoundCue.SHUTTER, null))
    audio.ringerNormal = false
    assertEquals(FeedbackOutcome.SUPPRESSED, player.play(SoundCue.SEND, null))
    assertEquals(listOf("shutter"), audio.events)
  }
}
