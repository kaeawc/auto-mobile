package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class PrototypeBundleManifestRequiresTest {
  private fun manifest(requires: String): ByteArray =
    """{"bundleFormatVersion":1,"specSha256":"${"0".repeat(64)}","assets":[],"fonts":[],"requires":$requires}"""
      .toByteArray()

  @Test
  fun `camelCase generated capability names are accepted`() {
    val parsed =
      PrototypeBundleManifestCodec.parse(
        manifest(
          """["prototype_platform_deviceStatus_v1","prototype_platform_secureStorage_v1"]""",
        ),
      )
    assertEquals(
      listOf("prototype_platform_deviceStatus_v1", "prototype_platform_secureStorage_v1"),
      parsed.requires,
    )
  }

  @Test
  fun `invalid, unsorted and duplicate requires are rejected`() {
    for (requires in
      listOf(
        """["SecureStorage"]""",
        """["prototype_platform_secure-storage_v1"]""",
        """["prototype_platform_secureStorage_v1","prototype_platform_deviceStatus_v1"]""",
        """["prototype_platform_secureStorage_v1","prototype_platform_secureStorage_v1"]""",
      )) {
      val failure =
        assertThrows<PrototypeBundleFailure>(requires) {
          PrototypeBundleManifestCodec.parse(manifest(requires))
        }
      assertEquals(PrototypeBundleErrorCode.requires_invalid, failure.code, requires)
    }
  }
}
