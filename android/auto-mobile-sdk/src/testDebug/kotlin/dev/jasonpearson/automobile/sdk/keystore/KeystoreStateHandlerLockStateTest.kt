package dev.jasonpearson.automobile.sdk.keystore

import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.UserNotAuthenticatedException
import java.security.KeyStoreException
import java.security.ProviderException
import java.security.UnrecoverableKeyException
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class KeystoreStateHandlerLockStateTest : KeystoreStateHandlerTestBase() {
  @Test
  fun `locked probe reports locked while still serving metadata`() {
    enable()
    probe.locked = DeviceLockState.LOCKED
    val json = handler.handle("metadata", "fixture", "aes")
    assertEquals("locked", json.getString("deviceLocked"))
    assertEquals("ok", json.getString("outcome"))
    assertEquals(listOf("containsAlias:aes"), backend.calls)
  }

  @Test
  fun `contract reserved exceptions map by type without leaking error messages`() {
    enable()
    listOf(KeyStoreException("secret"), ProviderException("secret")).forEach {
      backend.failure = it
      val json = handler.handle("metadata", "fixture", "aes")
      assertEquals("unavailable", json.getString("outcome"))
      assertFalse(json.toString().contains("secret"))
    }
    listOf(UserNotAuthenticatedException(), KeyPermanentlyInvalidatedException()).forEach {
      backend.failure = it
      assertEquals(
        "authentication_required",
        handler.handle("metadata", "fixture", "aes").getString("outcome"),
      )
    }
    backend.failure = UnrecoverableKeyException()
    probe.locked = DeviceLockState.LOCKED
    assertEquals("locked", handler.handle("metadata", "fixture", "aes").getString("outcome"))
    probe.locked = DeviceLockState.UNLOCKED
    assertEquals("unavailable", handler.handle("metadata", "fixture", "aes").getString("outcome"))
  }

  @Test
  fun `probe failure is unknown and does not block metadata`() {
    enable()
    probe.failure = SecurityException()
    val json = handler.handle("metadata", "fixture", "aes")
    assertEquals("unknown", json.getString("deviceLocked"))
    assertEquals("ok", json.getString("outcome"))
  }

  @Test
  fun `plain runtime exception from the lock probe is unknown and does not block metadata`() {
    enable()
    // KeyguardManager binder calls rethrow plain RuntimeException (rethrowFromSystemServer).
    probe.failure = RuntimeException("binder died")
    val json = handler.handle("metadata", "fixture", "aes")
    assertEquals("unknown", json.getString("deviceLocked"))
    assertEquals("ok", json.getString("outcome"))
  }
}
