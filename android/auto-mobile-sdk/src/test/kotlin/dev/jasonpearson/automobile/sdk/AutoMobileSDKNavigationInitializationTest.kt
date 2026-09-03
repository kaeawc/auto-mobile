package dev.jasonpearson.automobile.sdk

import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapabilityState
import dev.jasonpearson.automobile.sdk.crashes.AutoMobileCrashes
import dev.jasonpearson.automobile.sdk.database.DatabaseError
import dev.jasonpearson.automobile.sdk.database.DatabaseInspector
import dev.jasonpearson.automobile.sdk.storage.DataStoreAdapter
import dev.jasonpearson.automobile.sdk.storage.DataStoreEntry
import dev.jasonpearson.automobile.sdk.storage.DataStoreInspector
import dev.jasonpearson.automobile.sdk.storage.SharedPreferencesError
import dev.jasonpearson.automobile.sdk.storage.SharedPreferencesInspector
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.shadows.ShadowLooper

@RunWith(RobolectricTestRunner::class)
class AutoMobileSDKNavigationInitializationTest {
  private val context = RuntimeEnvironment.getApplication()
  private var preTestHandler: Thread.UncaughtExceptionHandler? = null
  private lateinit var assertionHandler: Thread.UncaughtExceptionHandler

  @Before
  fun setUp() {
    preTestHandler = Thread.getDefaultUncaughtExceptionHandler()
    AutoMobileSDK.shutdown()
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    AutoMobileCrashes.uninstall()
    DatabaseInspector.reset()
    DataStoreInspector.reset()
    SharedPreferencesInspector.reset()
    assertionHandler = Thread.UncaughtExceptionHandler { _, _ -> }
    Thread.setDefaultUncaughtExceptionHandler(assertionHandler)
  }

  @After
  fun tearDown() {
    AutoMobileSDK.shutdown()
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    DataStoreInspector.reset()
    Thread.setDefaultUncaughtExceptionHandler(preTestHandler)
  }

  @Test
  fun `navigation initialization creates delivery without broad SDK subsystems`() {
    AutoMobileSDK.initialize(NavigationConfiguration(context))

    assertNotNull(AutoMobileSDK.getEventBuffer())
    assertSame(assertionHandler, Thread.getDefaultUncaughtExceptionHandler())
    assertFalse(AutoMobileCrashes.isInitialized())
    val capabilities = AutoMobileSDK.capabilities.capabilities.associateBy { it.id }
    assertEquals(SdkCapabilityState.SUPPORTED, capabilities.getValue("events.navigation").state)
    assertEquals(SdkCapabilityState.UNSUPPORTED, capabilities.getValue("network.capture").state)
    try {
      DatabaseInspector.getDriver()
      fail("DatabaseInspector should not be initialized")
    } catch (_: DatabaseError.NotInitialized) {
      // Expected: navigation-only initialization must not initialize inspection.
    }
    try {
      SharedPreferencesInspector.getDriver()
      fail("SharedPreferencesInspector should not be initialized")
    } catch (_: SharedPreferencesError.NotInitialized) {
      // Expected: navigation-only initialization must not initialize inspection.
    }
  }

  @Test
  fun `navigation initialization is idempotent and shutdown releases delivery`() {
    val configuration = NavigationConfiguration(context)

    AutoMobileSDK.initialize(configuration)
    val firstBuffer = AutoMobileSDK.getEventBuffer()
    AutoMobileSDK.initialize(configuration)

    assertSame(firstBuffer, AutoMobileSDK.getEventBuffer())

    AutoMobileSDK.shutdown()

    assertNull(AutoMobileSDK.getEventBuffer())
    assertSame(assertionHandler, Thread.getDefaultUncaughtExceptionHandler())
  }

  @Test
  fun `concurrent navigation initialization creates one delivery runtime`() {
    val configuration = NavigationConfiguration(context)
    val start = CountDownLatch(1)
    val complete = CountDownLatch(2)

    val first = Thread {
      start.await()
      AutoMobileSDK.initialize(configuration)
      complete.countDown()
    }
    val second = Thread {
      start.await()
      AutoMobileSDK.initialize(configuration)
      complete.countDown()
    }
    first.start()
    second.start()
    start.countDown()
    assertTrue(complete.await(5, TimeUnit.SECONDS))

    assertNotNull(AutoMobileSDK.getEventBuffer())
    assertFalse(AutoMobileCrashes.isInitialized())
  }

  @Test
  fun `broad initialization does not replace an active navigation-only runtime`() {
    AutoMobileSDK.initialize(NavigationConfiguration(context))
    val navigationBuffer = AutoMobileSDK.getEventBuffer()

    AutoMobileSDK.initialize(context)
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()

    assertSame(navigationBuffer, AutoMobileSDK.getEventBuffer())
    assertFalse(AutoMobileCrashes.isInitialized())
  }

  @Test
  fun `broad initialization can start after navigation-only shutdown`() {
    AutoMobileSDK.initialize(NavigationConfiguration(context))
    AutoMobileSDK.shutdown()

    AutoMobileSDK.initialize(context)
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()

    assertTrue(AutoMobileCrashes.isInitialized())
  }

  @Test
  fun `navigation shutdown preserves host-owned DataStore registrations`() {
    val registration = DataStoreInspector.registerAdapter("host", EmptyDataStoreAdapter)

    try {
      AutoMobileSDK.initialize(NavigationConfiguration(context))
      AutoMobileSDK.shutdown()

      assertEquals(setOf("host"), DataStoreInspector.registeredAdapterNames())
    } finally {
      registration.unregister()
    }
  }

  @Test
  fun `disabling navigation-only tracking updates its capability state`() {
    AutoMobileSDK.initialize(NavigationConfiguration(context))

    AutoMobileSDK.setEnabled(false)

    val capabilities = AutoMobileSDK.capabilities.capabilities.associateBy { it.id }
    assertEquals(SdkCapabilityState.DISABLED, capabilities.getValue("events.navigation").state)
  }

  @Test
  fun `navigation shutdown restores enabled capability state`() {
    AutoMobileSDK.setEnabled(false)
    AutoMobileSDK.initialize(NavigationConfiguration(context))

    AutoMobileSDK.shutdown()
    AutoMobileSDK.initialize(context)
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()

    assertTrue(AutoMobileSDK.isCapabilitySupported("events.navigation"))
  }

  @Test
  fun `navigation initialization failure is contained and releases partial state`() {
    AutoMobileSDK.initialize(NavigationConfiguration(ThrowingApplicationContext(context)))

    assertNull(AutoMobileSDK.getEventBuffer())
    assertSame(assertionHandler, Thread.getDefaultUncaughtExceptionHandler())
  }

  @Test
  fun `navigation dispatch failure is contained`() {
    AutoMobileSDK.initialize(NavigationConfiguration(ThrowingBroadcastContext(context)))

    AutoMobileSDK.notifyNavigationEvent(
      NavigationEvent(
        destination = "Profile",
        source = NavigationSource.CIRCUIT,
      )
    )
    AutoMobileSDK.shutdown()

    assertNull(AutoMobileSDK.getEventBuffer())
  }

  private class ThrowingApplicationContext(base: Context) : ContextWrapper(base) {
    override fun getApplicationContext(): Context = error("Application context unavailable")
  }

  private class ThrowingBroadcastContext(base: Context) : ContextWrapper(base) {
    override fun getApplicationContext(): Context = this

    override fun sendBroadcast(intent: Intent) {
      error("Broadcast unavailable")
    }
  }

  private object EmptyDataStoreAdapter : DataStoreAdapter {
    override suspend fun storeNames(): List<String> = emptyList()

    override suspend fun read(storeName: String): List<DataStoreEntry> = emptyList()
  }
}
