package dev.jasonpearson.automobile.video

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Direct unit coverage for the video server's pure command-line parsing and validation. These paths
 * gate security-relevant inputs (socket name / session token) and the encoder's dimension
 * requirements, and were previously untested.
 */
class VideoServerArgumentsTest {

  // --- QualityPreset.fromString ---------------------------------------------------------------

  @Test
  fun qualityPresetFromStringIsCaseInsensitive() {
    assertEquals(QualityPreset.LOW, QualityPreset.fromString("low"))
    assertEquals(QualityPreset.MEDIUM, QualityPreset.fromString("MEDIUM"))
    assertEquals(QualityPreset.HIGH, QualityPreset.fromString("High"))
  }

  @Test
  fun qualityPresetFromStringRejectsUnknownValues() {
    val error =
      assertThrows(IllegalArgumentException::class.java) { QualityPreset.fromString("ultra") }
    assertEquals("Unknown quality preset: ultra", error.message)
  }

  // --- VideoServer.parseQuality ---------------------------------------------------------------

  @Test
  fun parseQualityReadsLongAndShortFlags() {
    assertEquals(QualityPreset.HIGH, VideoServer.parseQuality(arrayOf("--quality", "high")))
    assertEquals(QualityPreset.LOW, VideoServer.parseQuality(arrayOf("-q", "low")))
  }

  @Test
  fun parseQualityDefaultsToMediumWhenAbsentOrInvalid() {
    assertEquals(QualityPreset.MEDIUM, VideoServer.parseQuality(arrayOf()))
    // An invalid preset is reported to stderr and falls back to MEDIUM rather than crashing.
    assertEquals(QualityPreset.MEDIUM, VideoServer.parseQuality(arrayOf("--quality", "bogus")))
    // A trailing flag with no value is ignored.
    assertEquals(QualityPreset.MEDIUM, VideoServer.parseQuality(arrayOf("--quality")))
  }

  // --- VideoServer.parseIntFlag ---------------------------------------------------------------

  @Test
  fun parseIntFlagReadsPositiveValuesAndRejectsTheRest() {
    assertEquals(
      2_500_000,
      VideoServer.parseIntFlag(arrayOf("--bit-rate", "2500000"), "--bit-rate"),
    )
    assertNull(VideoServer.parseIntFlag(arrayOf("--bit-rate", "0"), "--bit-rate"))
    assertNull(VideoServer.parseIntFlag(arrayOf("--bit-rate", "-5"), "--bit-rate"))
    assertNull(VideoServer.parseIntFlag(arrayOf("--bit-rate", "abc"), "--bit-rate"))
    assertNull(VideoServer.parseIntFlag(arrayOf("--bit-rate"), "--bit-rate"))
    assertNull(VideoServer.parseIntFlag(arrayOf(), "--bit-rate"))
  }

  // --- VideoServer.resolveFps -----------------------------------------------------------------

  @Test
  fun resolveFpsFallsBackToThePresetDefaultWhenFlagIsAbsent() {
    // The preset default is now 30fps for every preset, decoupled from resolution/bitrate.
    assertEquals(30, VideoServer.resolveFps(arrayOf(), QualityPreset.MEDIUM))
    assertEquals(30, VideoServer.resolveFps(arrayOf("--quality", "high"), QualityPreset.HIGH))
  }

  @Test
  fun resolveFpsHonorsAnExplicitPositiveFlag() {
    assertEquals(24, VideoServer.resolveFps(arrayOf("--fps", "24"), QualityPreset.MEDIUM))
    assertEquals(15, VideoServer.resolveFps(arrayOf("--fps", "15"), QualityPreset.HIGH))
  }

  @Test
  fun resolveFpsIgnoresNonPositiveOrMalformedFlagAndUsesThePresetDefault() {
    assertEquals(30, VideoServer.resolveFps(arrayOf("--fps", "0"), QualityPreset.MEDIUM))
    assertEquals(30, VideoServer.resolveFps(arrayOf("--fps", "-5"), QualityPreset.MEDIUM))
    assertEquals(30, VideoServer.resolveFps(arrayOf("--fps", "abc"), QualityPreset.MEDIUM))
    assertEquals(30, VideoServer.resolveFps(arrayOf("--fps"), QualityPreset.MEDIUM))
  }

  // --- VideoServer.parseSizeFlag --------------------------------------------------------------

  @Test
  fun parseSizeFlagParsesWidthHeightWithEitherSeparator() {
    assertEquals(720 to 1280, VideoServer.parseSizeFlag(arrayOf("--size", "720x1280")))
    assertEquals(720 to 1280, VideoServer.parseSizeFlag(arrayOf("--size", "720X1280")))
  }

  @Test
  fun parseSizeFlagRoundsDownToEvenDimensions() {
    // MediaCodec requires even dimensions; odd values round down by clearing the low bit.
    assertEquals(720 to 1280, VideoServer.parseSizeFlag(arrayOf("--size", "721x1281")))
  }

  @Test
  fun parseSizeFlagRejectsMalformedOrZeroCollapsingValues() {
    assertNull(VideoServer.parseSizeFlag(arrayOf()))
    assertNull(VideoServer.parseSizeFlag(arrayOf("--size")))
    assertNull(VideoServer.parseSizeFlag(arrayOf("--size", "720")))
    assertNull(VideoServer.parseSizeFlag(arrayOf("--size", "720x1280x60")))
    assertNull(VideoServer.parseSizeFlag(arrayOf("--size", "axb")))
    assertNull(VideoServer.parseSizeFlag(arrayOf("--size", "0x1280")))
    assertNull(VideoServer.parseSizeFlag(arrayOf("--size", "-720x1280")))
    // 1x1 rounds to 0x0, which would defer into an opaque encoder failure, so it is rejected.
    assertNull(VideoServer.parseSizeFlag(arrayOf("--size", "1x1")))
  }

  // --- VideoSessionArguments.parse ------------------------------------------------------------

  @Test
  fun parseDefaultsSocketNameAndLeavesOptionalFieldsNull() {
    val options = VideoSessionArguments.parse(arrayOf())
    assertEquals("automobile_video", options.socketName)
    assertNull(options.token)
    assertNull(options.ownerPid)
    assertNull(options.deviceSerial)
    assertNull(options.forwardPort)
  }

  @Test
  fun parseAcceptsFullyPopulatedValidArguments() {
    val options =
      VideoSessionArguments.parse(
        arrayOf(
          "--socket-name",
          "automobile_video.session-1",
          "--session-token",
          "abcd-efgh-1234",
          "--owner-pid",
          "4321",
          "--device-serial",
          "emulator-5554",
          "--forward-port",
          "61234",
        )
      )
    assertEquals("automobile_video.session-1", options.socketName)
    assertEquals("abcd-efgh-1234", options.token)
    assertEquals(4321L, options.ownerPid)
    assertEquals("emulator-5554", options.deviceSerial)
    assertEquals(61234, options.forwardPort)
  }

  @Test
  fun parseRejectsSocketNamesOutsideTheSafeCharacterSet() {
    assertThrows(IllegalArgumentException::class.java) {
      VideoSessionArguments.parse(arrayOf("--socket-name", "bad name with spaces"))
    }
    assertThrows(IllegalArgumentException::class.java) {
      VideoSessionArguments.parse(arrayOf("--socket-name", "../escape"))
    }
    assertThrows(IllegalArgumentException::class.java) {
      // Empty violates the {1,100} length bound.
      VideoSessionArguments.parse(arrayOf("--socket-name", ""))
    }
    assertThrows(IllegalArgumentException::class.java) {
      // 101 characters exceeds the length bound.
      VideoSessionArguments.parse(arrayOf("--socket-name", "a".repeat(101)))
    }
  }

  @Test
  fun parseRejectsTokensOutsideTheSafeCharacterSet() {
    assertThrows(IllegalArgumentException::class.java) {
      // Too short (< 8 characters).
      VideoSessionArguments.parse(arrayOf("--session-token", "short"))
    }
    assertThrows(IllegalArgumentException::class.java) {
      // Underscore is not in the token character class.
      VideoSessionArguments.parse(arrayOf("--session-token", "has_underscore_1"))
    }
    assertThrows(IllegalArgumentException::class.java) {
      // 81 characters exceeds the {8,80} bound.
      VideoSessionArguments.parse(arrayOf("--session-token", "a".repeat(81)))
    }
  }

  @Test
  fun parseIgnoresNonPositiveOwnerPidAndForwardPort() {
    val options = VideoSessionArguments.parse(arrayOf("--owner-pid", "0", "--forward-port", "-1"))
    assertNull(options.ownerPid)
    assertNull(options.forwardPort)
  }
}
