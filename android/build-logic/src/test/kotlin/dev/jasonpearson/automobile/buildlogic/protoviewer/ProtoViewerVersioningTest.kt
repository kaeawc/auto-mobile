package dev.jasonpearson.automobile.buildlogic.protoviewer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtoViewerVersioningTest {
  @Test
  fun derivesCodeFromMajorMinorPatch() {
    assertEquals(89, ProtoViewerVersioning.versionCode("0.0.89"))
    assertEquals(1_002_003, ProtoViewerVersioning.versionCode("1.2.3"))
    assertEquals(2_099_999_999, ProtoViewerVersioning.versionCode("2099.999.999"))
  }

  @Test
  fun staysUnderPlayCap() {
    assertTrue(
      ProtoViewerVersioning.versionCode("2099.999.999") <
        ProtoViewerVersioning.PLAY_MAX_VERSION_CODE,
    )
  }

  @Test
  fun isStrictlyMonotonicInVersionOrder() {
    val ordered =
      listOf("0.0.1", "0.0.89", "0.0.999", "0.1.0", "0.999.999", "1.0.0", "1.0.1", "1.2.0", "2.0.0")
    val codes = ordered.map(ProtoViewerVersioning::versionCode)
    assertEquals(codes.sorted(), codes)
    assertEquals(codes.size, codes.toSet().size)
  }

  @Test
  fun currentReleasesOutrankTheLocalCode() {
    assertTrue(
      ProtoViewerVersioning.versionCode("0.0.2") > ProtoViewerVersioning.LOCAL_VERSION_CODE,
    )
  }

  @Test
  fun rejectsSuffixesAndMalformedVersions() {
    listOf("0.0.89-SNAPSHOT", "1.2", "1.2.3.4", "v1.2.3", "1.2.3+4", "01.2.3", "", "a.b.c")
      .forEach {
        assertThrows(it, IllegalArgumentException::class.java) {
          ProtoViewerVersioning.versionCode(it)
        }
      }
  }

  @Test
  fun rejectsOutOfRangeFields() {
    assertThrows(IllegalArgumentException::class.java) {
      ProtoViewerVersioning.versionCode("2100.0.0")
    }
    assertThrows(IllegalArgumentException::class.java) {
      ProtoViewerVersioning.versionCode("1.1000.0")
    }
    assertThrows(IllegalArgumentException::class.java) {
      ProtoViewerVersioning.versionCode("1.0.1000")
    }
  }
}
