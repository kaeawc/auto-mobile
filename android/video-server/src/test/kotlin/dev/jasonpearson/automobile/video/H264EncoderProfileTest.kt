package dev.jasonpearson.automobile.video

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * Pins the on-device encoder to H.264 Main profile (issue #4756).
 *
 * `H264EncoderProfile.KEY_PROFILE` is a `const val` initialized from
 * `MediaCodecInfo.CodecProfileLevel.AVCProfileMain`, a `public static final int` in `android.jar`.
 * Kotlin inlines that compile-time constant, so this test can pin the numeric value without the
 * Android stub on the test classpath (this module compiles android APIs `compileOnly` and has no
 * MediaCodec runtime — see [VideoServerRotationSwapTest]).
 *
 * `MediaCodecInfo.CodecProfileLevel` defines `AVCProfileBaseline = 0x01` and `AVCProfileMain =
 * 0x02` (stable platform constants). This is the Kotlin half of the per-source contract: the
 * encoder emits Main, and the host publisher (`src/features/webrtc/h264Level.ts` +
 * `h264ProfileNegotiation.test.ts`) advertises and validates Main for the Android session while
 * keeping Baseline for iOS/synthetic sources. Reverting to Baseline here — the #4877 direction —
 * changes the inlined constant and reddens this test.
 */
class H264EncoderProfileTest {
  private companion object {
    const val AVC_PROFILE_BASELINE = 0x01
    const val AVC_PROFILE_MAIN = 0x02
  }

  @Test
  fun `encoder requests Main profile`() {
    assertEquals(AVC_PROFILE_MAIN, H264EncoderProfile.KEY_PROFILE)
  }

  @Test
  fun `encoder no longer requests Constrained Baseline`() {
    assertNotEquals(AVC_PROFILE_BASELINE, H264EncoderProfile.KEY_PROFILE)
  }
}
