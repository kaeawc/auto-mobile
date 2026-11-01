package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

internal class CtrlProxyMessageHandlerStorageTest : CtrlProxyMessageHandlerFixtures() {
  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches scoped reset_keystore`() = runTest {
    dispatch(
      """{"type":"reset_keystore","requestId":"kr1","packageName":"com.example","scope":"login","alias":"token"}""",
    )
    assertEquals("resetKeystore" to listOf<Any?>("kr1", "com.example", "login", "token"), lastCall)
  }

  @Test
  fun `dispatches list_preference_files`() = runTest {
    dispatch("""{"type":"list_preference_files","requestId":"lf1","packageName":"com.example"}""")
    assertEquals("listPreferenceFiles" to listOf<Any?>("lf1", "com.example"), lastCall)
  }

  @Test
  fun `dispatches get_preferences`() = runTest {
    dispatch(
      """{"type":"get_preferences","requestId":"gp1","packageName":"com.example","fileName":"settings.xml"}""",
    )
    assertEquals("getPreferences" to listOf<Any?>("gp1", "com.example", "settings.xml"), lastCall)
  }

  @Test
  fun `dispatches read only keystore discovery`() = runTest {
    dispatch("""{"type":"discover_keystore","requestId":"ks1","packageName":"com.example"}""")
    assertEquals("discoverKeystore" to listOf<Any?>("ks1", "com.example"), lastCall)
  }

  @Test
  fun `dispatches get_sdk_capabilities`() = runTest {
    dispatch("""{"type":"get_sdk_capabilities","requestId":"sc1","packageName":"com.example"}""")
    assertEquals("getSdkCapabilities" to listOf<Any?>("sc1", "com.example", null), lastCall)
  }

  @Test
  fun `dispatches get_sdk_capabilities with a target user`() = runTest {
    dispatch(
      """{"type":"get_sdk_capabilities","requestId":"sc2","packageName":"com.example","userId":10}""",
    )
    assertEquals("getSdkCapabilities" to listOf<Any?>("sc2", "com.example", 10), lastCall)
  }

  @Test
  fun `dispatches list_data_stores`() = runTest {
    dispatch(
      """{"type":"list_data_stores","requestId":"lds1","packageName":"com.example","adapterName":"settings"}""",
    )
    assertEquals("listDataStores" to listOf<Any?>("lds1", "com.example", "settings"), lastCall)
  }

  @Test
  fun `dispatches get_data_store`() = runTest {
    dispatch(
      """{"type":"get_data_store","requestId":"gds1","packageName":"com.example","adapterName":"settings","storeName":"user_prefs"}""",
    )
    assertEquals(
      "getDataStore" to listOf<Any?>("gds1", "com.example", "settings", "user_prefs"),
      lastCall,
    )
  }

  @Test
  fun `dispatches subscribe_storage`() = runTest {
    dispatch(
      """{"type":"subscribe_storage","requestId":"sub1","packageName":"com.example","fileName":"settings.xml"}""",
    )
    assertEquals(
      "subscribeStorage" to listOf<Any?>("sub1", "com.example", "settings.xml"),
      lastCall,
    )
  }

  @Test
  fun `unsubscribe_storage with only subscriptionId resolves packageName and fileName`() = runTest {
    // Real TS traffic sends only the subscriptionId ("packageName:fileName"). The handler must
    // split
    // it and dispatch the unsubscribe so the device actually tears down the subscription.
    dispatch(
      """{"type":"unsubscribe_storage","requestId":"unsub1","subscriptionId":"com.example:settings.xml"}""",
    )
    assertEquals(
      "unsubscribeStorage" to listOf<Any?>("unsub1", "com.example", "settings.xml"),
      lastCall,
    )
    assertTrue("no diagnostic log expected for a resolvable subscriptionId", logs.isEmpty())
  }

  @Test
  fun `unsubscribe_storage splits subscriptionId on the first colon only`() = runTest {
    // subscriptionId = "packageName:fileName"; a file name may itself contain ':', so only the
    // first
    // ':' delimits packageName from fileName.
    dispatch(
      """{"type":"unsubscribe_storage","requestId":"unsub3","subscriptionId":"com.example:weird:name.xml"}""",
    )
    assertEquals(
      "unsubscribeStorage" to listOf<Any?>("unsub3", "com.example", "weird:name.xml"),
      lastCall,
    )
  }

  @Test
  fun `unsubscribe_storage with a malformed subscriptionId is a logged no-op`() = runTest {
    dispatch("""{"type":"unsubscribe_storage","requestId":"unsub4","subscriptionId":"nocolon"}""")
    assertTrue("no action should fire for an unsplittable subscriptionId", calls.isEmpty())
    assertEquals(1, logs.size)
    assertTrue(logs[0], logs[0].contains("malformed subscriptionId=nocolon"))
  }

  @Test
  fun `unsubscribe_storage rejects an empty package or file segment as malformed`() = runTest {
    // A real subscription can never have an empty package or file, so these are unsplittable.
    dispatch(
      """{"type":"unsubscribe_storage","requestId":"unsub5","subscriptionId":":settings.xml"}""",
    )
    dispatch(
      """{"type":"unsubscribe_storage","requestId":"unsub6","subscriptionId":"com.example:"}""",
    )
    assertTrue("no action should fire for an empty-segment subscriptionId", calls.isEmpty())
    assertEquals(2, logs.size)
    assertTrue(logs[0], logs[0].contains("malformed subscriptionId=:settings.xml"))
    assertTrue(logs[1], logs[1].contains("malformed subscriptionId=com.example:"))
  }

  @Test
  fun `unsubscribe_storage prefers explicit packageName and fileName over subscriptionId`() =
    runTest {
      // If a client ever sends both, the explicit fields are authoritative over the parsed id.
      dispatch(
        """{"type":"unsubscribe_storage","requestId":"unsub7","subscriptionId":"other.pkg:other.xml","packageName":"com.example","fileName":"settings.xml"}""",
      )
      assertEquals(
        "unsubscribeStorage" to listOf<Any?>("unsub7", "com.example", "settings.xml"),
        lastCall,
      )
    }

  @Test
  fun `unsubscribe_storage without any identifier is a logged no-op`() = runTest {
    dispatch("""{"type":"unsubscribe_storage","requestId":"unsub8"}""")
    assertTrue("no action should fire without any identifier", calls.isEmpty())
    assertEquals(1, logs.size)
    assertTrue(logs[0], logs[0].contains("without subscriptionId or packageName/fileName"))
  }

  @Test
  fun `unsubscribe_storage with packageName and fileName invokes the action`() = runTest {
    dispatch(
      """{"type":"unsubscribe_storage","requestId":"unsub2","packageName":"com.example","fileName":"settings.xml"}""",
    )
    assertEquals(
      "unsubscribeStorage" to listOf<Any?>("unsub2", "com.example", "settings.xml"),
      lastCall,
    )
  }

  @Test
  fun `dispatches get_preference`() = runTest {
    dispatch(
      """{"type":"get_preference","requestId":"gpr1","packageName":"com.example","fileName":"settings.xml","key":"theme"}""",
    )
    assertEquals(
      "getPreference" to listOf<Any?>("gpr1", "com.example", "settings.xml", "theme"),
      lastCall,
    )
  }

  @Test
  fun `dispatches set_preference`() = runTest {
    dispatch(
      """{"type":"set_preference","requestId":"spr1","packageName":"com.example","fileName":"settings.xml","key":"theme","value":"dark","valueType":"string"}""",
    )
    assertEquals(
      "setPreference" to
        listOf<Any?>("spr1", "com.example", "settings.xml", "theme", "dark", "string"),
      lastCall,
    )
  }

  @Test
  fun `dispatches remove_preference`() = runTest {
    dispatch(
      """{"type":"remove_preference","requestId":"rp1","packageName":"com.example","fileName":"settings.xml","key":"theme"}""",
    )
    assertEquals(
      "removePreference" to listOf<Any?>("rp1", "com.example", "settings.xml", "theme"),
      lastCall,
    )
  }

  @Test
  fun `dispatches clear_preferences`() = runTest {
    dispatch(
      """{"type":"clear_preferences","requestId":"clp1","packageName":"com.example","fileName":"settings.xml"}""",
    )
    assertEquals(
      "clearPreferences" to listOf<Any?>("clp1", "com.example", "settings.xml"),
      lastCall,
    )
  }
}
