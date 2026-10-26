package dev.jasonpearson.automobile.buildlogic.protoviewer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtoViewerReleaseConfigTest {
  private val complete =
    ProtoViewerReleaseInputs(
      requireRelease = true,
      releaseVersion = "0.0.89",
      keystorePath = "keystore/protoviewer.keystore",
      keystorePassword = "store-secret",
      keyAlias = "protoviewer",
      keyPassword = "key-secret",
    )

  private fun plan(inputs: ProtoViewerReleaseInputs, exists: Boolean = true) =
    ProtoViewerReleaseConfig.plan(inputs) { exists }

  @Test
  fun completeRequiredInputsSignWithReleaseKeyAndDeriveVersion() {
    val result = plan(complete)
    assertTrue(result.errors.isEmpty())
    assertTrue(result.useReleaseKey)
    assertEquals("0.0.89", result.versionName)
    assertEquals(89, result.versionCode)
  }

  @Test
  fun requiredBuildFailsClosedOnEveryMissingSigningInput() {
    val result = plan(ProtoViewerReleaseInputs(true, "0.0.89", null, " ", "", null))
    assertEquals(1, result.errors.size)
    val message = result.errors.single()
    listOf(
        ProtoViewerInputNames.KEYSTORE_PATH,
        ProtoViewerInputNames.KEYSTORE_PASSWORD,
        ProtoViewerInputNames.KEY_ALIAS,
        ProtoViewerInputNames.KEY_PASSWORD,
      )
      .forEach { assertTrue(it, message.contains(it)) }
    assertFalse(result.useReleaseKey)
  }

  @Test
  fun requiredBuildNamesOnlyTheMissingInput() {
    val message = plan(complete.copy(keyAlias = null)).errors.single()
    assertTrue(message.contains(ProtoViewerInputNames.KEY_ALIAS))
    assertFalse(message.contains(ProtoViewerInputNames.KEYSTORE_PASSWORD))
  }

  @Test
  fun requiredBuildFailsWhenKeystoreFileIsAbsent() {
    val result = plan(complete, exists = false)
    assertTrue(result.errors.single().contains("existing keystore file"))
    assertFalse(result.useReleaseKey)
  }

  @Test
  fun requiredBuildFailsWithoutReleaseVersion() {
    val result = plan(complete.copy(releaseVersion = null))
    assertTrue(result.errors.single().contains(ProtoViewerInputNames.RELEASE_VERSION))
  }

  @Test
  fun snapshotVersionNeverPublishes() {
    val result = plan(complete.copy(releaseVersion = "0.0.89-SNAPSHOT"))
    assertTrue(result.errors.single().contains("SNAPSHOT"))
    assertNull(result.versionName)
    assertEquals(ProtoViewerVersioning.LOCAL_VERSION_CODE, result.versionCode)
  }

  @Test
  fun localBuildFallsBackToDebugKeyAndLocalVersion() {
    val result = plan(ProtoViewerReleaseInputs(false, null, null, null, null, null))
    assertTrue(result.errors.isEmpty())
    assertFalse(result.useReleaseKey)
    assertNull(result.versionName)
    assertEquals(ProtoViewerVersioning.LOCAL_VERSION_CODE, result.versionCode)
  }

  @Test
  fun localBuildWithFullKeystoreUsesReleaseKey() {
    val result = plan(complete.copy(requireRelease = false, releaseVersion = null))
    assertTrue(result.errors.isEmpty())
    assertTrue(result.useReleaseKey)
  }

  @Test
  fun explicitlyInvalidVersionIsAnErrorEvenWhenNotRequired() {
    val result = plan(complete.copy(requireRelease = false, releaseVersion = "garbage"))
    assertTrue(result.errors.single().contains(ProtoViewerInputNames.RELEASE_VERSION))
  }

  @Test
  fun inputNamesAreDedicatedAndNeverReuseCtrlProxyKeys() {
    listOf(
        ProtoViewerInputNames.KEYSTORE_PATH,
        ProtoViewerInputNames.KEYSTORE_PASSWORD,
        ProtoViewerInputNames.KEY_ALIAS,
        ProtoViewerInputNames.KEY_PASSWORD,
      )
      .forEach { assertTrue(it, it.startsWith("PROTOVIEWER_") && !it.startsWith("RELEASE_")) }
  }
}
