package dev.jasonpearson.automobile.sdk.capabilities

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class SdkCapabilityJsonTest {
  @Test
  fun `full document round trip preserves every state and reason`() {
    val document =
      SdkCapabilityDocument(
        capabilities =
          SdkCapabilityState.entries.map {
            SdkCapabilityDescriptor("host.${it.name}", it, "Reason for ${it.name}")
          },
        policy = SdkCapturePolicy(true, true, true),
      )

    assertEquals(document, decode(document.toSnapshotJson()))
    assertEquals(document.toSnapshotJson(), document.toSnapshotJson())
  }

  @Test
  fun `encoding pins field order and includes all defaults`() {
    assertEquals(
      """{"schemaVersion":1,"capabilities":[{"id":"events.navigation","state":"SUPPORTED","reason":null}],"policy":{"captureHeaders":false,"captureBodies":false,"allowMutations":false}}""",
      navigationDocument.toSnapshotJson(),
    )
  }

  @Test
  fun `partial snapshot does not invent absent capabilities`() {
    assertEquals(navigationDocument, decode(navigationDocument.toSnapshotJson()))
    assertEquals(
      listOf("events.navigation"),
      decode(navigationDocument.toSnapshotJson()).capabilities.map { it.id },
    )
  }

  @Test
  fun `host registered capability survives alongside registry defaults`() {
    val registry = SdkCapabilityRegistry()
    registry.markInitialized()
    registry.register(
      SdkCapabilityDescriptor("host.extra", SdkCapabilityState.SUPPORTED, "Host hook")
    )

    val snapshot = registry.snapshot()
    assertEquals(snapshot, decode(snapshot.toSnapshotJson()))
    assertTrue(decode(snapshot.toSnapshotJson()).capabilities.any { it.id == "host.extra" })
  }

  @Test
  fun `policy changes and network unregister produce independent snapshots`() {
    val registry = SdkCapabilityRegistry()
    registry.markInitialized()
    val before = registry.snapshot().toSnapshotJson()
    registry.updatePolicy(SdkCapturePolicy(captureHeaders = true, captureBodies = true))
    val after = registry.snapshot().toSnapshotJson()
    registry.unregister("network.capture")
    val revoked = registry.snapshot().toSnapshotJson()

    assertEquals(SdkCapturePolicy(), decode(before).policy)
    assertEquals(SdkCapturePolicy(true, true), decode(after).policy)
    assertEquals(SdkCapturePolicy(), decode(revoked).policy)
    assertEquals(
      SdkCapabilityState.SUPPORTED,
      decode(revoked).capabilities.first { it.id == "network.capture" }.state,
    )
  }

  @Test
  fun `malformed and structurally invalid snapshots are failures with reasons`() {
    val invalid =
      listOf(
        "",
        "not JSON",
        "{",
        "null",
        "[]",
        "{}",
        """{"schemaVersion":1,"policy":{}}""",
        """{"schemaVersion":1,"capabilities":[]}""",
        """{"schemaVersion":1,"capabilities":null,"policy":{}}""",
        """{"schemaVersion":1,"capabilities":{},"policy":{}}""",
        """{"schemaVersion":1,"capabilities":[],"policy":false}""",
        """{"schemaVersion":1,"capabilities":[],"policy":{"captureHeaders":"true"}}""",
        """{"schemaVersion":1,"capabilities":[],"policy":{"captureBodies":"false"}}""",
        """{"schemaVersion":1,"capabilities":[],"policy":{"allowMutations":"true"}}""",
        """{"schemaVersion":1,"capabilities":[{"id":42,"state":"SUPPORTED"}],"policy":{}}""",
        """{"schemaVersion":1,"capabilities":[{"id":"x","state":"SUPPORTED","reason":42}],"policy":{}}""",
        """{"schemaVersion":1,"capabilities":[{"id":"x","state":42}],"policy":{}}""",
        """{"schemaVersion":1,"capabilities":[{"id":"x","state":null}],"policy":{}}""",
        """{"schemaVersion":1,"capabilities":[{"id":"x"}],"policy":{}}""",
        """{"schemaVersion":1,"capabilities":[{"state":"SUPPORTED"}],"policy":{}}""",
        """{"schemaVersion":2,"capabilities":[],"policy":null}""",
      )

    invalid.forEach(::assertFailure)
  }

  @Test
  fun `schema version must be explicitly present and a positive integer`() {
    assertFailure("""{"capabilities":[],"policy":{}}""")
    listOf("0", "-1", "1.5", "null", "true", "[]", "{}", "2147483648", "\"1\"").forEach {
      assertFailure("""{"schemaVersion":$it,"capabilities":[],"policy":{}}""")
    }
  }

  @Test
  fun `future versions decode best effort without discarding their version`() {
    val document = navigationDocument.copy(schemaVersion = 2)

    assertEquals(document, decode(document.toSnapshotJson()))
  }

  @Test
  fun `unknown keys are tolerated at every document level`() {
    assertEquals(navigationDocument, decode(unknownKeysJson))
  }

  @Test
  fun `unknown state strings become UNKNOWN and preserve reasons`() {
    val json =
      """{"schemaVersion":3,"capabilities":[{"id":"host.extra","state":"FUTURE_STATE","reason":"New state"}],"policy":{}}"""

    assertEquals(
      SdkCapabilityDescriptor("host.extra", SdkCapabilityState.UNKNOWN, "New state"),
      decode(json).capabilities.single(),
    )
  }

  @Test
  fun `explicit empty capability list is valid`() {
    val document = navigationDocument.copy(capabilities = emptyList())

    assertEquals(document, decode(document.toSnapshotJson()))
  }

  @Test
  fun `encoding leaves registry snapshot semantics unchanged`() {
    val registry = SdkCapabilityRegistry()
    val before = registry.snapshot()
    before.toSnapshotJson()

    assertEquals(before, registry.snapshot())
    assertFalse(before.policy.captureHeaders)
    assertEquals(
      SdkCapabilityState.NOT_INITIALIZED,
      before.capabilities.first { it.id == "events.navigation" }.state,
    )
  }

  private fun decode(json: String): SdkCapabilityDocument {
    val result = decodeSdkCapabilitySnapshot(json)
    assertTrue("Expected success: $result", result is SdkCapabilitySnapshotResult.Success)
    return (result as SdkCapabilitySnapshotResult.Success).document
  }

  private fun assertFailure(json: String) {
    val result = decodeSdkCapabilitySnapshot(json)
    assertTrue("Expected failure for $json: $result", result is SdkCapabilitySnapshotResult.Failure)
    assertTrue((result as SdkCapabilitySnapshotResult.Failure).reason.isNotBlank())
  }

  companion object {
    private const val unknownKeysJson =
      """{"schemaVersion":1,"extra":true,"capabilities":[{"id":"events.navigation","state":"SUPPORTED","extra":{}}],"policy":{"extra":[]}}"""

    private val navigationDocument =
      SdkCapabilityDocument(
        capabilities =
          listOf(SdkCapabilityDescriptor("events.navigation", SdkCapabilityState.SUPPORTED)),
        policy = SdkCapturePolicy(),
      )

    @BeforeClass
    @JvmStatic
    fun warmSerialization() {
      decodeSdkCapabilitySnapshot(navigationDocument.toSnapshotJson())
      decodeSdkCapabilitySnapshot(unknownKeysJson)
    }
  }
}
