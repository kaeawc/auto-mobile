package dev.jasonpearson.automobile.desktop.core.navigation

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Pure provenance-opacity logic for nav (app,build) Phase 2 (#4985): the 100%/50% split, the
 * active-wins-when-both rule, the offline (null-context) behavior, and the accessible provenance
 * descriptions.
 */
class NavigationProvenanceTest {

  private val activeContext =
    NavigationActiveContext(deviceId = "emulator-5554", packageId = "com.example.app")

  private fun record(
    versionCode: Int = 1,
    contentHash: String = "hashA",
    deviceId: String = "emulator-5554",
    sessionUuid: String = "session-1",
    lastSeen: Long = 100L,
    packageId: String = "com.example.app",
  ) =
    ScreenProvenance(
      buildKey = ProvenanceBuildKey(packageId, versionCode, contentHash),
      deviceId = deviceId,
      sessionUuid = sessionUuid,
      lastSeen = lastSeen,
    )

  @Test
  fun `node reached in active context is full opacity`() {
    val provenance = listOf(record(deviceId = "emulator-5554"))
    assertEquals(
      ProvenanceOpacity.ACTIVE_ALPHA,
      ProvenanceOpacity.alphaFor(provenance, activeContext),
    )
    assertFalse(ProvenanceOpacity.isFaded(provenance, activeContext))
  }

  @Test
  fun `node reached only by another device is faded`() {
    val provenance = listOf(record(deviceId = "emulator-9999"))
    assertEquals(
      ProvenanceOpacity.FADED_ALPHA,
      ProvenanceOpacity.alphaFor(provenance, activeContext),
    )
    assertTrue(ProvenanceOpacity.isFaded(provenance, activeContext))
  }

  @Test
  fun `active wins when reached by both active and other contexts`() {
    val provenance = listOf(record(deviceId = "emulator-9999"), record(deviceId = "emulator-5554"))
    assertEquals(
      ProvenanceOpacity.ACTIVE_ALPHA,
      ProvenanceOpacity.alphaFor(provenance, activeContext),
    )
    assertEquals(
      "Home — active in current context",
      ProvenanceOpacity.contentDescription("Home", provenance, activeContext),
    )
  }

  @Test
  fun `build key mismatch fades even on the active device`() {
    val ctxWithBuild =
      activeContext.copy(
        buildKey = ProvenanceBuildKey("com.example.app", versionCode = 2, contentHash = "hashB")
      )
    // Same device, but an older build → historical.
    val provenance = listOf(record(versionCode = 1, contentHash = "hashA"))
    assertEquals(
      ProvenanceOpacity.FADED_ALPHA,
      ProvenanceOpacity.alphaFor(provenance, ctxWithBuild),
    )
    // A matching build on the active device → active.
    val matching = listOf(record(versionCode = 2, contentHash = "hashB"))
    assertEquals(ProvenanceOpacity.ACTIVE_ALPHA, ProvenanceOpacity.alphaFor(matching, ctxWithBuild))
  }

  @Test
  fun `null context renders union at full opacity (offline)`() {
    val provenance = listOf(record(deviceId = "emulator-9999"))
    assertEquals(ProvenanceOpacity.ACTIVE_ALPHA, ProvenanceOpacity.alphaFor(provenance, null))
    assertEquals(
      "Home — union view (no active context)",
      ProvenanceOpacity.contentDescription("Home", provenance, null),
    )
  }

  @Test
  fun `empty provenance is opaque and labeled`() {
    assertEquals(
      ProvenanceOpacity.ACTIVE_ALPHA,
      ProvenanceOpacity.alphaFor(emptyList(), activeContext),
    )
    assertEquals(
      "Home — no recorded provenance",
      ProvenanceOpacity.contentDescription("Home", emptyList(), activeContext),
    )
  }

  @Test
  fun `faded description surfaces build device session and lastSeen`() {
    val provenance =
      listOf(
        record(versionCode = 2, contentHash = "hashB", deviceId = "emulator-9999", lastSeen = 250L)
      )
    assertEquals(
      "Home — historical: build v2 (hashB), device emulator-9999, session session-1, last seen 250",
      ProvenanceOpacity.contentDescription("Home", provenance, activeContext),
    )
  }

  @Test
  fun `legacy empty content hash reads as no hash`() {
    val provenance =
      listOf(record(versionCode = 0, contentHash = "", deviceId = "legacy", sessionUuid = "legacy"))
    assertEquals(
      "Home — historical: build v0 (no hash), device legacy, session legacy, last seen 100",
      ProvenanceOpacity.contentDescription("Home", provenance, activeContext),
    )
  }
}
