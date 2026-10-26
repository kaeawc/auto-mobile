package dev.jasonpearson.automobile.buildlogic.signing

import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReleaseSigningGuardTest {
  @Test
  fun allowsDebugFallbackWhenSigningIsNotRequired() {
    assertNull(ReleaseSigningGuard.violation(required = false, resolvedSigningConfigName = "debug"))
  }

  @Test
  fun allowsReleaseKeyWhenRequired() {
    assertNull(ReleaseSigningGuard.violation(required = true, resolvedSigningConfigName = "release"))
  }

  @Test
  fun failsClosedOnDebugFallbackWhenRequired() {
    val message = ReleaseSigningGuard.violation(required = true, resolvedSigningConfigName = "debug")
    assertTrue(message.orEmpty().contains("'debug'"))
    assertTrue(message.orEmpty().contains("RELEASE_KEYSTORE_PATH"))
  }

  @Test
  fun failsClosedWhenNoSigningConfigResolvedAndRequired() {
    val message = ReleaseSigningGuard.violation(required = true, resolvedSigningConfigName = "")
    assertTrue(message.orEmpty().contains("no signing config"))
  }
}
