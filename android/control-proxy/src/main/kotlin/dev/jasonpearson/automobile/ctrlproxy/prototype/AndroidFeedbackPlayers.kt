package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaActionSound
import android.media.ToneGenerator
import android.os.Build
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings

// Android haptic and sound feedback for the overlay (#14329). The mappings are pure and tested
// with fake gateways; the System* gateways are the only code that touches a service.

/** How one [HapticEffect] is vibrated at an API level. */
sealed interface HapticPlan {
  /** `VibrationEffect.createPredefined`, API 29+. */
  data class Predefined(val effectId: Int) : HapticPlan

  /** `VibrationEffect.createOneShot` for devices below API 29. */
  data class OneShot(val durationMs: Long, val amplitude: Int) : HapticPlan

  data class Waveform(val timings: LongArray, val amplitudes: IntArray) : HapticPlan
}

/** `VibrationEffect.EFFECT_*` values, repeated so the mapping runs without the framework. */
internal object VibrationEffectIds {
  const val CLICK = 0
  const val DOUBLE_CLICK = 1
  const val TICK = 2
  const val HEAVY_CLICK = 5
}

internal const val PREDEFINED_EFFECTS_MIN_SDK = 29

/**
 * The vibration for [effect]. From API 29 each effect is a predefined one; success, warning and
 * error have no View-less confirm/reject constant, so they use a double click, a heavy click and a
 * two-pulse waveform. Below API 29 every effect is a one-shot or waveform with a tuned duration.
 */
internal fun hapticPlan(effect: HapticEffect, sdkInt: Int): HapticPlan {
  if (sdkInt >= PREDEFINED_EFFECTS_MIN_SDK) {
    return when (effect) {
      HapticEffect.CLICK,
      HapticEffect.IMPACT_MEDIUM -> HapticPlan.Predefined(VibrationEffectIds.CLICK)
      HapticEffect.TICK,
      HapticEffect.SELECTION,
      HapticEffect.IMPACT_LIGHT -> HapticPlan.Predefined(VibrationEffectIds.TICK)
      HapticEffect.HEAVY_CLICK,
      HapticEffect.IMPACT_HEAVY,
      HapticEffect.LONG_PRESS,
      HapticEffect.WARNING -> HapticPlan.Predefined(VibrationEffectIds.HEAVY_CLICK)
      HapticEffect.DOUBLE_CLICK,
      HapticEffect.SUCCESS -> HapticPlan.Predefined(VibrationEffectIds.DOUBLE_CLICK)
      HapticEffect.ERROR ->
        HapticPlan.Waveform(longArrayOf(0, 30, 60, 30), intArrayOf(0, 255, 0, 255))
    }
  }
  return when (effect) {
    HapticEffect.TICK,
    HapticEffect.SELECTION,
    HapticEffect.IMPACT_LIGHT -> HapticPlan.OneShot(8, 80)
    HapticEffect.CLICK,
    HapticEffect.IMPACT_MEDIUM -> HapticPlan.OneShot(15, 160)
    HapticEffect.HEAVY_CLICK,
    HapticEffect.IMPACT_HEAVY,
    HapticEffect.WARNING -> HapticPlan.OneShot(30, 255)
    HapticEffect.LONG_PRESS -> HapticPlan.OneShot(45, 200)
    HapticEffect.DOUBLE_CLICK,
    HapticEffect.SUCCESS ->
      HapticPlan.Waveform(longArrayOf(0, 15, 50, 15), intArrayOf(0, 160, 0, 160))
    HapticEffect.ERROR ->
      HapticPlan.Waveform(longArrayOf(0, 30, 60, 30), intArrayOf(0, 255, 0, 255))
  }
}

/** The vibrator and the touch-feedback setting, behind a seam so tests need no framework. */
interface VibratorGateway {
  val available: Boolean

  /** False when "Touch feedback" (haptic feedback) is off in system settings. */
  val touchFeedbackEnabled: Boolean

  fun vibrate(plan: HapticPlan)
}

class AndroidHapticsPlayer(
  private val gateway: VibratorGateway,
  private val sdkInt: Int = Build.VERSION.SDK_INT,
) : HapticsPlayer {
  override fun perform(effect: HapticEffect): FeedbackOutcome =
    when {
      !gateway.available -> FeedbackOutcome.UNAVAILABLE
      !gateway.touchFeedbackEnabled -> FeedbackOutcome.SUPPRESSED
      else -> {
        gateway.vibrate(hapticPlan(effect, sdkInt))
        FeedbackOutcome.PLAYED
      }
    }
}

/** `ToneGenerator.TONE_PROP_*` values for the two cues without a system sound effect. */
internal object ToneIds {
  const val ACK = 25
  const val PROMPT = 27
}

/** The audio side: ringer state, the touch-sounds setting and the three ways a cue is produced. */
interface AudioGateway {
  /** False in silent or vibrate ringer mode, where no cue should sound. */
  val ringerNormal: Boolean

  /** False when "Touch sounds" is off in system settings. */
  val touchSoundsEnabled: Boolean

  fun playClick(volumePercent: Int?)

  fun playShutter()

  fun playTone(toneId: Int, volumePercent: Int?)
}

class AndroidSoundPlayer(private val gateway: AudioGateway) : SoundPlayer {
  override fun play(cue: SoundCue, volume: Int?): FeedbackOutcome {
    if (!gateway.ringerNormal) return FeedbackOutcome.SUPPRESSED
    when (cue) {
      SoundCue.CLICK -> {
        if (!gateway.touchSoundsEnabled) return FeedbackOutcome.SUPPRESSED
        gateway.playClick(volume)
      }
      SoundCue.SHUTTER -> gateway.playShutter()
      SoundCue.SEND -> gateway.playTone(ToneIds.ACK, volume)
      SoundCue.RECEIVE -> gateway.playTone(ToneIds.PROMPT, volume)
    }
    return FeedbackOutcome.PLAYED
  }
}

/** The real vibrator. Vibrations from a service use the touch usage so they are not dropped. */
class SystemVibratorGateway(private val context: Context) : VibratorGateway {
  private companion object {
    const val FALLBACK_PULSE_MS = 20L
  }

  private val vibrator: Vibrator? by lazy {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      context.getSystemService(VibratorManager::class.java)?.defaultVibrator
    } else {
      @Suppress("DEPRECATION") context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }
  }

  override val available: Boolean
    get() = vibrator?.hasVibrator() == true

  override val touchFeedbackEnabled: Boolean
    get() =
      Settings.System.getInt(context.contentResolver, Settings.System.HAPTIC_FEEDBACK_ENABLED, 1) !=
        0

  override fun vibrate(plan: HapticPlan) {
    val target = vibrator ?: return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      vibrateLegacy(target, plan)
      return
    }
    val effect =
      when (plan) {
        is HapticPlan.Predefined ->
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            VibrationEffect.createPredefined(plan.effectId)
          } else {
            // The planner only picks a predefined effect on API 29+; a short pulse is the floor.
            VibrationEffect.createOneShot(FALLBACK_PULSE_MS, VibrationEffect.DEFAULT_AMPLITUDE)
          }
        is HapticPlan.OneShot -> VibrationEffect.createOneShot(plan.durationMs, plan.amplitude)
        is HapticPlan.Waveform -> VibrationEffect.createWaveform(plan.timings, plan.amplitudes, -1)
      }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      target.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH))
    } else {
      @Suppress("DEPRECATION")
      target.vibrate(
        effect,
        AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION).build(),
      )
    }
  }

  /** API 24-25 has no `VibrationEffect`: durations only, amplitudes are dropped. */
  @Suppress("DEPRECATION")
  private fun vibrateLegacy(target: Vibrator, plan: HapticPlan) {
    when (plan) {
      is HapticPlan.Predefined -> target.vibrate(FALLBACK_PULSE_MS)
      is HapticPlan.OneShot -> target.vibrate(plan.durationMs)
      is HapticPlan.Waveform -> target.vibrate(plan.timings, -1)
    }
  }
}

/** The real audio: system sound effects, `MediaActionSound` and short system tones. */
class SystemAudioGateway(private val context: Context) : AudioGateway {
  private val audio: AudioManager? by lazy { context.getSystemService(AudioManager::class.java) }

  override val ringerNormal: Boolean
    get() = audio?.ringerMode == AudioManager.RINGER_MODE_NORMAL

  override val touchSoundsEnabled: Boolean
    get() =
      Settings.System.getInt(context.contentResolver, Settings.System.SOUND_EFFECTS_ENABLED, 1) != 0

  override fun playClick(volumePercent: Int?) {
    audio?.playSoundEffect(AudioManager.FX_KEY_CLICK, (volumePercent ?: 100) / 100f)
  }

  override fun playShutter() {
    val sound = MediaActionSound()
    sound.play(MediaActionSound.SHUTTER_CLICK)
    sound.release()
  }

  override fun playTone(toneId: Int, volumePercent: Int?) {
    val generator =
      ToneGenerator(AudioManager.STREAM_NOTIFICATION, volumePercent ?: DEFAULT_TONE_VOLUME)
    generator.startTone(toneId, TONE_MILLIS)
    // The generator stops itself after the tone; releasing early would cut it off.
    android.os
      .Handler(android.os.Looper.getMainLooper())
      .postDelayed(generator::release, TONE_MILLIS + 50L)
  }

  private companion object {
    const val DEFAULT_TONE_VOLUME = 80
    const val TONE_MILLIS = 150
  }
}

/** The modules the overlay registers on every build: both need no runtime permission. */
internal fun prototypeFeedbackModules(context: Context) =
  listOf(
    HapticsModule(AndroidHapticsPlayer(SystemVibratorGateway(context))),
    SoundModule(AndroidSoundPlayer(SystemAudioGateway(context))),
  )
