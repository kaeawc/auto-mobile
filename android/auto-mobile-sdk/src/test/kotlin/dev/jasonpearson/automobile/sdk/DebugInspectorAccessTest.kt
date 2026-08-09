package dev.jasonpearson.automobile.sdk

import org.junit.Assert.assertFalse
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
      )
    )
  }

  @Test
  fun `rejects unrelated app callers`() {
    assertFalse(
      DebugInspectorAccess.isAuthorized(
        callingUid = 10_212,
        ownUid = 10_210,
        callingPackages = setOf("com.example.untrusted"),
      )
    )
  }

  private object ProcessUid {
    const val ROOT = 0
    const val SHELL = 2_000
  }
}
