package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.v2.createComposeRule
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

internal class FakePrototypeTraceSink(var enabled: Boolean = true) : PrototypeTraceSink {
  val events = mutableListOf<String>()
  val asyncCookies = mutableListOf<Int>()
  var enabledChecks = 0
  private val stack = mutableListOf<String>()
  private val asyncSections = mutableMapOf<Int, String>()
  val openSections: List<String>
    get() = stack.toList() + asyncSections.values

  override fun isEnabled(): Boolean {
    enabledChecks++
    return enabled
  }

  override fun begin(name: String) {
    events += "begin:$name"
    stack += name
  }

  override fun end() {
    check(stack.isNotEmpty()) { "unmatched trace end" }
    events += "end:${stack.removeAt(stack.lastIndex)}"
  }

  override fun beginAsync(name: String, cookie: Int) {
    check(cookie !in asyncSections) { "duplicate async cookie" }
    asyncSections[cookie] = name
    asyncCookies += cookie
    events += "beginAsync:$name:$cookie"
  }

  override fun endAsync(name: String, cookie: Int) {
    check(asyncSections.remove(cookie) == name) { "unmatched async trace end" }
    events += "endAsync:$name:$cookie"
  }
}

class PrototypeTraceTest {
  private val original = PrototypeTrace.sink
  private val fake = FakePrototypeTraceSink()

  @After
  fun restoreSink() {
    PrototypeTrace.sink = original
  }

  private fun useFake() {
    PrototypeTrace.sink = fake
  }

  @Test
  fun `async sections nest with distinct cookies and balance on their original sink`() = runTest {
    useFake()
    assertEquals(
      42,
      PrototypeTrace.asyncSection("outer") {
        PrototypeTrace.asyncSection("inner") { 7 }
        fake.enabled = false
        PrototypeTrace.sink = FakePrototypeTraceSink()
        42
      },
    )
    val outer = fake.asyncCookies[0]
    val inner = fake.asyncCookies[1]
    assertNotEquals(outer, inner)
    assertEquals(
      listOf(
        "beginAsync:outer:$outer",
        "beginAsync:inner:$inner",
        "endAsync:inner:$inner",
        "endAsync:outer:$outer",
      ),
      fake.events,
    )
    assertEquals(2, fake.enabledChecks)
    assertTrue(fake.openSections.isEmpty())
  }

  @Test
  fun `async section balances when the block throws`() = runTest {
    useFake()
    val failure = IllegalStateException("expected")
    assertSame(
      failure,
      runCatching { PrototypeTrace.asyncSection("throwing") { throw failure } }.exceptionOrNull(),
    )
    val cookie = fake.asyncCookies.single()
    assertEquals(listOf("beginAsync:throwing:$cookie", "endAsync:throwing:$cookie"), fake.events)
    assertTrue(fake.openSections.isEmpty())
  }

  @Test
  fun `async section balances when cancelled while suspended`() = runTest {
    useFake()
    val job =
      launch(start = CoroutineStart.UNDISPATCHED) {
        PrototypeTrace.asyncSection("cancelled") { awaitCancellation() }
      }
    val cookie = fake.asyncCookies.single()
    assertEquals(listOf("beginAsync:cancelled:$cookie"), fake.events)
    job.cancelAndJoin()
    assertTrue(job.isCancelled)
    assertEquals(listOf("beginAsync:cancelled:$cookie", "endAsync:cancelled:$cookie"), fake.events)
    assertTrue(fake.openSections.isEmpty())
  }

  @Test
  fun `disabled async tracing runs the block without recording sections`() = runTest {
    useFake()
    fake.enabled = false
    assertEquals(42, PrototypeTrace.asyncSection("disabled") { 42 })
    assertEquals(1, fake.enabledChecks)
    assertTrue(fake.events.isEmpty())
    assertTrue(fake.asyncCookies.isEmpty())
    assertTrue(fake.openSections.isEmpty())
  }

  @Test
  fun `default async sink is inert on a plain JVM`() = runTest {
    PrototypeTrace.sink = original
    assertEquals(7, PrototypeTrace.asyncSection("x") { 7 })
  }

  @Test
  fun `section balances when the block throws and skips disabled tracing`() {
    useFake()
    val failure = IllegalStateException("expected")
    assertSame(
      failure,
      runCatching { PrototypeTrace.section("throwing") { throw failure } }.exceptionOrNull(),
    )
    assertEquals(listOf("begin:throwing", "end:throwing"), fake.events)
    assertTrue(fake.openSections.isEmpty())
    fake.enabled = false
    fake.events.clear()
    assertEquals(42, PrototypeTrace.section("disabled") { 42 })
    assertTrue(fake.events.isEmpty())
    assertTrue(fake.openSections.isEmpty())
  }

  @Test
  fun `default sink is inert on a plain JVM`() {
    PrototypeTrace.sink = original
    assertEquals(7, PrototypeTrace.section("x") { 7 })
  }

  @Test
  fun `disabled tracing skips mapping and state write sections`() = runTest {
    useFake()
    fake.enabled = false
    val spec = semanticsSpec(PrototypeTextNode(text = "Hello"))
    PrototypeRenderMapper().map(spec, emptyMap())
    mapPrototypeSpec(spec)
    val runtime = PrototypeRuntime(spec, nextSequence = { 0L })
    runtime.prepareStateWrites = { PrototypeStateWriteValidator { null } }
    val write =
      PrototypeInteraction.Tap(
        listOf(PrototypeSetStateAction("count", PrototypeScalar.Numeric(1.0))),
      )
    runtime.handle(write)
    runtime.handle(write)
    assertTrue(fake.events.isEmpty())
    assertTrue(fake.openSections.isEmpty())
  }

  @Test
  fun `mapper traces only misses and full mapping uses its own section`() {
    useFake()
    val spec = semanticsSpec(PrototypeTextNode(text = "Hello"))
    val mapper = PrototypeRenderMapper()
    val first = mapper.map(spec, emptyMap())
    assertSame(first, mapper.map(spec, emptyMap()))
    assertEquals(
      listOf("begin:Prototype.mapRenderTree", "end:Prototype.mapRenderTree"),
      fake.events,
    )
    fake.events.clear()
    mapPrototypeSpec(spec)
    assertEquals(
      listOf("begin:Prototype.mapPrototypeSpec", "end:Prototype.mapPrototypeSpec"),
      fake.events,
    )
  }

  @Test
  fun `first write nests preparation and the second write reuses it`() = runTest {
    useFake()
    val runtime =
      PrototypeRuntime(semanticsSpec(PrototypeTextNode(text = "Hello")), nextSequence = { 0L })
    runtime.prepareStateWrites = { PrototypeStateWriteValidator { null } }
    val write =
      PrototypeInteraction.Tap(
        listOf(PrototypeSetStateAction("count", PrototypeScalar.Numeric(1.0))),
      )
    fake.events.clear()
    runtime.handle(write)
    assertEquals(
      listOf(
        "begin:Prototype.validateStateWrite",
        "begin:Prototype.prepareStateWrites",
        "end:Prototype.prepareStateWrites",
        "end:Prototype.validateStateWrite",
      ),
      fake.events,
    )
    fake.events.clear()
    runtime.handle(write)
    assertEquals(
      listOf("begin:Prototype.validateStateWrite", "end:Prototype.validateStateWrite"),
      fake.events,
    )
    assertTrue(fake.openSections.isEmpty())
  }
}

/** Runtime-content harness reused from PrototypeAnchorFadeTest also covers Prototype.compose. */
@RunWith(RobolectricTestRunner::class)
class PrototypeComposeTraceTest {
  @get:Rule val compose = createComposeRule()
  private val original = PrototypeTrace.sink
  private val fake = FakePrototypeTraceSink()

  @After
  fun restoreSink() {
    PrototypeTrace.sink = original
  }

  private fun render(enabled: Boolean): List<String> {
    fake.enabled = enabled
    PrototypeTrace.sink = fake
    val composed = mutableListOf<String>()
    val spec =
      semanticsSpec(
        PrototypeColumnNode(
          children = listOf(PrototypeIconNode(name = "home"), PrototypeTextNode(text = "Hello")),
        ),
      )
    val runtime = PrototypeRuntime(spec, nextSequence = { 0L })
    fake.events.clear()
    compose.setContent {
      CompositionLocalProvider(LocalPrototypeCompositionProbe provides { composed += it }) {
        PrototypeRuntimeContent(runtime) { runtime.handle(it) }
      }
    }
    compose.waitForIdle()
    return composed
  }

  @Test
  fun `enabled node tracing balances one pair for every composed node and includes compose`() {
    val composed = render(true)
    assertEquals(setOf("root", "root.children[0]", "root.children[1]"), composed.toSet())
    assertEquals(composed.size, fake.events.count { it == "begin:Prototype.node" })
    assertEquals(composed.size, fake.events.count { it == "end:Prototype.node" })
    assertTrue(fake.events.contains("begin:Prototype.compose"))
    assertEquals(
      fake.events.count { it == "begin:Prototype.compose" },
      fake.events.count { it == "end:Prototype.compose" },
    )
    assertTrue(fake.openSections.isEmpty())
  }

  @Test
  fun `disabled tracing records no compose or node sections`() {
    assertEquals(3, render(false).size)
    assertTrue(fake.events.isEmpty())
    assertTrue(fake.openSections.isEmpty())
  }
}
