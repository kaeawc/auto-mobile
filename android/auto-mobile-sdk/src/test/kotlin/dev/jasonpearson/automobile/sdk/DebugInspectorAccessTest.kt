package dev.jasonpearson.automobile.sdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class DebugInspectorAccessTest {

  @Test
  fun `allows adb shell callers`() {
    assertTrue(DebugInspectorAccess.isAuthorized(ProcessUid.SHELL, ownUid = 10_210))
  }

  @Test
  fun `allows root callers`() {
    assertTrue(DebugInspectorAccess.isAuthorized(ProcessUid.ROOT, ownUid = 10_210))
  }

  @Test
  fun `allows the host app caller`() {
    assertTrue(DebugInspectorAccess.isAuthorized(callingUid = 10_210, ownUid = 10_210))
  }

  @Test
  fun `allows the CtrlProxy caller`() {
    assertTrue(
      DebugInspectorAccess.isAuthorized(
        callingUid = 10_211,
        ownUid = 10_210,
        callingPackages = setOf(SdkConstants.CTRL_PROXY_PACKAGE),
      ),
    )
  }

  @Test
  fun `rejects unrelated app callers`() {
    assertFalse(
      DebugInspectorAccess.isAuthorized(
        callingUid = 10_212,
        ownUid = 10_210,
        callingPackages = setOf("com.example.untrusted"),
      ),
    )
  }

  @Test
  fun `allows the shell caller without a cross-user package lookup`() {
    val resolver = CrossUserThrowingResolver()

    DebugInspectorAccess.enforceCaller(ProcessUid.SHELL, AAOS_OWN_UID, resolver)

    assertEquals(0, resolver.lookups)
  }

  @Test
  fun `allows the root caller without a package lookup`() {
    val resolver = CrossUserThrowingResolver()

    DebugInspectorAccess.enforceCaller(ProcessUid.ROOT, AAOS_OWN_UID, resolver)

    assertEquals(0, resolver.lookups)
  }

  @Test
  fun `allows the own uid without a package lookup`() {
    val resolver = CrossUserThrowingResolver()

    DebugInspectorAccess.enforceCaller(AAOS_OWN_UID, AAOS_OWN_UID, resolver)

    assertEquals(0, resolver.lookups)
  }

  @Test
  fun `denies another app when the package lookup throws`() {
    val resolver = CrossUserThrowingResolver()

    assertThrows(SecurityException::class.java) {
      DebugInspectorAccess.enforceCaller(OTHER_APP_UID, AAOS_OWN_UID, resolver)
    }
    assertEquals(1, resolver.lookups)
  }

  @Test
  fun `allows the CtrlProxy caller resolved from the same user`() {
    DebugInspectorAccess.enforceCaller(OTHER_APP_UID, AAOS_OWN_UID) { uid ->
      if (uid == OTHER_APP_UID) arrayOf(SdkConstants.CTRL_PROXY_PACKAGE) else null
    }
  }

  @Test
  fun `denies another app whose packages resolve to an unrelated app`() {
    assertThrows(SecurityException::class.java) {
      DebugInspectorAccess.enforceCaller(OTHER_APP_UID, AAOS_OWN_UID) {
        arrayOf("com.example.untrusted")
      }
    }
  }

  /** Fake PackageManager lookup that rejects every lookup as a cross-user query, as AAOS does. */
  private class CrossUserThrowingResolver : DebugInspectorAccess.CallingPackageResolver {
    var lookups = 0

    override fun packagesForUid(uid: Int): Array<String>? {
      lookups++
      throw SecurityException("uid $uid requires INTERACT_ACROSS_USERS")
    }
  }

  private object ProcessUid {
    const val ROOT = 0
    const val SHELL = 2_000
  }

  private companion object {
    // Host app installed in AAOS user 10 (uid = userId * 100000 + appId).
    const val AAOS_OWN_UID = 1_010_210
    const val OTHER_APP_UID = 1_010_212
  }
}
