package dev.jasonpearson.automobile.sdk.adapters

import androidx.compose.runtime.Applier
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Composition
import androidx.compose.runtime.MonotonicFrameClock
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import com.slack.circuit.foundation.NavEvent
import com.slack.circuit.foundation.navstack.SaveableNavStack
import com.slack.circuit.runtime.Navigator
import com.slack.circuit.runtime.screen.Screen
import com.slack.circuit.test.FakeNavigator
import com.slack.circuitx.navigation.intercepting.InterceptedResult
import com.slack.circuitx.navigation.intercepting.NavigationContext
import com.slack.circuitx.navigation.intercepting.NavigationEventListener
import com.slack.circuitx.navigation.intercepting.NavigationInterceptor
import com.slack.circuitx.navigation.intercepting.rememberInterceptingNavigator
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.NavigationEvent
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class CircuitNavigationEventListenerTest {

  @Before
  fun setUp() {
    AutoMobileSDK.clearNavigationListeners()
    AutoMobileSDK.setEnabled(true)
    CircuitAdapter.stop()
  }

  @After
  fun tearDown() {
    AutoMobileSDK.clearNavigationListeners()
    CircuitAdapter.stop()
  }

  @Test
  fun `listener tracks the initial screen and committed navigation stack changes`() = runTest {
    val events = collectEvents()
    val delegate = fakeNavigator(HomeScreen)
    lateinit var navigator: Navigator
    val composition = TestComposition()

    try {
      composition.setContent {
        val listener = CircuitAdapter.rememberCircuitNavigationEventListener()
        navigator =
          rememberInterceptingNavigator(
            navigator = delegate,
            eventListeners = listOf(listener),
            enableBackHandler = false,
          )
      }

      composition.awaitIdle()
      navigator.goTo(DetailScreen("one"))
      composition.awaitIdle()
      navigator.backward()
      composition.awaitIdle()
      navigator.forward()
      composition.awaitIdle()
      navigator.pop()
      composition.awaitIdle()
      navigator.resetRoot(SettingsScreen)
      composition.awaitIdle()

      assertEquals(
        listOf(
          "HomeScreen",
          "DetailScreen",
          "HomeScreen",
          "DetailScreen",
          "HomeScreen",
          "SettingsScreen",
        ),
        events.map(NavigationEvent::destination),
      )
      assertTrue(events.all { it.arguments.isEmpty() && it.metadata.isEmpty() })
    } finally {
      composition.dispose()
    }
  }

  @Test
  fun `trackScreen remains available for manual Circuit tracking`() {
    val events = collectEvents()

    CircuitAdapter.start()
    CircuitAdapter.trackScreen(
      screen = DetailScreen("manual"),
      arguments = mapOf("id" to "manual"),
      metadata = mapOf("source" to "manual"),
    )

    assertEquals("DetailScreen", events.single().destination)
    assertEquals(mapOf("id" to "manual"), events.single().arguments)
    assertEquals(mapOf("source" to "manual"), events.single().metadata)
  }

  @Test
  fun `listener reports equal screen values for each committed stack mutation`() = runTest {
    val events = collectEvents()
    val delegate = fakeNavigator(HomeScreen)
    lateinit var navigator: Navigator
    val composition = TestComposition()

    try {
      composition.setContent {
        val listener = CircuitAdapter.rememberCircuitNavigationEventListener()
        navigator =
          rememberInterceptingNavigator(
            navigator = delegate,
            eventListeners = listOf(listener),
            enableBackHandler = false,
          )
      }

      composition.awaitIdle()
      navigator.goTo(DetailScreen("same"))
      composition.awaitIdle()
      navigator.resetRoot(DetailScreen("same"))
      composition.awaitIdle()

      assertEquals(
        listOf("HomeScreen", "DetailScreen", "DetailScreen"),
        events.map(NavigationEvent::destination),
      )
    } finally {
      composition.dispose()
    }
  }

  @Test
  fun `listener reports the rewritten destination and ignores consumed operations`() = runTest {
    val events = collectEvents()
    val rewrittenNavigator = fakeNavigator(HomeScreen)
    val consumedNavigator = fakeNavigator(SettingsScreen)
    lateinit var rewritten: Navigator
    lateinit var consumed: Navigator
    val composition = TestComposition()

    try {
      composition.setContent {
        val listener = CircuitAdapter.rememberCircuitNavigationEventListener()
        rewritten =
          rememberInterceptingNavigator(
            navigator = rewrittenNavigator,
            interceptors = listOf(RewriteGoToInterceptor),
            eventListeners = listOf(listener),
            enableBackHandler = false,
          )
        consumed =
          rememberInterceptingNavigator(
            navigator = consumedNavigator,
            interceptors = listOf(ConsumeGoToInterceptor),
            eventListeners = listOf(listener),
            enableBackHandler = false,
          )
      }

      composition.awaitIdle()
      rewritten.goTo(RequestedScreen)
      composition.awaitIdle()
      consumed.goTo(RequestedScreen)
      composition.awaitIdle()

      assertEquals(
        listOf("HomeScreen", "SettingsScreen", "RewrittenScreen"),
        events.map(NavigationEvent::destination),
      )
    } finally {
      composition.dispose()
    }
  }

  @Test
  fun `listener remains stable and uses updated extractors after recomposition`() = runTest {
    val events = collectEvents()
    val delegate = fakeNavigator(HomeScreen)
    var useUpdatedExtractors by mutableStateOf(false)
    lateinit var navigator: Navigator
    var listener: NavigationEventListener? = null
    val composition = TestComposition()

    try {
      composition.setContent {
        listener =
          CircuitAdapter.rememberCircuitNavigationEventListener(
            extractArguments = { screen ->
              mapOf(
                "extractor" to if (useUpdatedExtractors) "updated" else "initial",
                "screen" to screen,
              )
            },
            extractMetadata = {
              mapOf("metadata" to if (useUpdatedExtractors) "updated" else "initial")
            },
          )
        navigator =
          rememberInterceptingNavigator(
            navigator = delegate,
            eventListeners = listOf(requireNotNull(listener)),
            enableBackHandler = false,
          )
      }

      composition.awaitIdle()
      val initialListener = requireNotNull(listener)
      useUpdatedExtractors = true
      composition.awaitIdle()
      navigator.goTo(DetailScreen("updated"))
      composition.awaitIdle()

      assertSame(initialListener, listener)
      assertEquals("updated", events.last().arguments["extractor"])
      assertEquals("updated", events.last().metadata["metadata"])
    } finally {
      composition.dispose()
    }
  }

  @Test
  fun `listener contains extractor failures`() = runTest {
    val events = collectEvents()
    val delegate = fakeNavigator(HomeScreen)
    lateinit var navigator: Navigator
    val composition = TestComposition()

    try {
      composition.setContent {
        val listener =
          CircuitAdapter.rememberCircuitNavigationEventListener(
            extractArguments = { error("extractor failure") }
          )
        navigator =
          rememberInterceptingNavigator(
            navigator = delegate,
            eventListeners = listOf(listener),
            enableBackHandler = false,
          )
      }

      composition.awaitIdle()
      navigator.goTo(DetailScreen("ignored"))
      composition.awaitIdle()

      assertTrue(events.isEmpty())
    } finally {
      composition.dispose()
    }
  }

  @Test
  fun `stop remains effective after listener recomposition`() = runTest {
    var recompositionVersion by mutableStateOf(0)
    val composition = TestComposition()

    try {
      composition.setContent {
        val currentVersion = recompositionVersion
        CircuitAdapter.rememberCircuitNavigationEventListener(
          extractMetadata = { mapOf("version" to currentVersion.toString()) }
        )
      }

      composition.awaitIdle()
      assertTrue(CircuitAdapter.isActive())

      CircuitAdapter.stop()
      recompositionVersion = 1
      composition.awaitIdle()

      assertFalse(CircuitAdapter.isActive())
    } finally {
      composition.dispose()
    }
  }

  @Test
  fun `independent navigator registrations each track their destinations`() = runTest {
    val events = collectEvents()
    val outerDelegate = fakeNavigator(HomeScreen)
    val nestedDelegate = fakeNavigator(SettingsScreen)
    lateinit var outerNavigator: Navigator
    lateinit var nestedNavigator: Navigator
    val composition = TestComposition()

    try {
      composition.setContent {
        val outerListener = CircuitAdapter.rememberCircuitNavigationEventListener()
        val nestedListener = CircuitAdapter.rememberCircuitNavigationEventListener()
        outerNavigator =
          rememberInterceptingNavigator(
            navigator = outerDelegate,
            eventListeners = listOf(outerListener),
            enableBackHandler = false,
          )
        nestedNavigator =
          rememberInterceptingNavigator(
            navigator = nestedDelegate,
            eventListeners = listOf(nestedListener),
            enableBackHandler = false,
          )
      }

      composition.awaitIdle()
      outerNavigator.goTo(DetailScreen("outer"))
      nestedNavigator.goTo(DetailScreen("nested"))
      composition.awaitIdle()

      assertEquals(
        listOf("HomeScreen", "SettingsScreen", "DetailScreen", "DetailScreen"),
        events.map(NavigationEvent::destination),
      )
    } finally {
      composition.dispose()
    }
  }

  private fun collectEvents(): MutableList<NavigationEvent> {
    return mutableListOf<NavigationEvent>().also { events ->
      AutoMobileSDK.addNavigationListener(events::add)
    }
  }

  private fun fakeNavigator(root: Screen): FakeNavigator = FakeNavigator(SaveableNavStack(root))

  private data object HomeScreen : Screen

  private data object SettingsScreen : Screen

  private data class DetailScreen(val id: String) : Screen

  private data object RequestedScreen : Screen

  private data object RewrittenScreen : Screen

  private object RewriteGoToInterceptor : NavigationInterceptor {
    override fun goTo(
      screen: Screen,
      navigationContext: NavigationContext,
    ): InterceptedResult {
      return if (screen == RequestedScreen) {
        InterceptedResult.Rewrite(NavEvent.GoTo(RewrittenScreen))
      } else {
        InterceptedResult.Success(consumed = false)
      }
    }
  }

  private object ConsumeGoToInterceptor : NavigationInterceptor {
    override fun goTo(
      screen: Screen,
      navigationContext: NavigationContext,
    ): InterceptedResult {
      return NavigationInterceptor.SuccessConsumed
    }
  }

  private class TestComposition {
    private val scope = CoroutineScope(Dispatchers.Unconfined + ImmediateFrameClock)
    private val recomposer = Recomposer(scope.coroutineContext)
    private val composition = Composition(UnitApplier(), recomposer)

    init {
      scope.launch { recomposer.runRecomposeAndApplyChanges() }
    }

    fun setContent(content: @Composable () -> Unit) {
      composition.setContent(content)
    }

    suspend fun awaitIdle() {
      Snapshot.sendApplyNotifications()
      recomposer.awaitIdle()
    }

    fun dispose() {
      composition.dispose()
      recomposer.close()
      scope.cancel()
    }
  }

  private object ImmediateFrameClock : MonotonicFrameClock {
    override val key: CoroutineContext.Key<*> = MonotonicFrameClock

    override suspend fun <R> withFrameNanos(onFrame: (Long) -> R): R {
      return onFrame(System.nanoTime())
    }
  }

  private class UnitApplier : Applier<Unit> {
    override val current: Unit = Unit

    override fun down(node: Unit) = Unit

    override fun up() = Unit

    override fun insertBottomUp(index: Int, instance: Unit) = Unit

    override fun insertTopDown(index: Int, instance: Unit) = Unit

    override fun move(from: Int, to: Int, count: Int) = Unit

    override fun remove(index: Int, count: Int) = Unit

    override fun clear() = Unit
  }
}
