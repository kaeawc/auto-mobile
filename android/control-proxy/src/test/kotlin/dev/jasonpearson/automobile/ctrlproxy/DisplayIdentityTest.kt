package dev.jasonpearson.automobile.ctrlproxy

import java.lang.reflect.InvocationTargetException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class DisplayIdentityTest {
  @Test
  fun `unavailable mode read omits fingerprint and permits the next read`() {
    val error = IllegalStateException("Unable to locate mode id=1")
    val errors = mutableListOf<IllegalStateException>()
    assertNull(readPanelFingerprint(readMode = { throw error }, onUnavailable = { errors.add(it) }))
    assertSame(error, errors.single())
    assertEquals(
      PanelFingerprint(2076, 2152),
      readPanelFingerprint(
        readMode = { panelFingerprintFromSize(2076, 2152) },
        onUnavailable = { errors.add(it) },
      ),
    )
    assertEquals(1, errors.size)
  }

  @Test
  fun `fingerprint reader requires positive native dimensions`() {
    assertEquals(PanelFingerprint(2076, 2152), panelFingerprintFromSize(2076, 2152))
    for ((width, height) in listOf(0 to 1, 1 to 0, -1 to 1, 1 to -1)) {
      assertNull(panelFingerprintFromSize(width, height))
    }
    assertNull(panelFingerprintOf(null))
  }

  private class FakeDisplay(var id: String)

  @Test
  fun `sdk 35 resolves hidden unique id`() {
    var lookups = 0
    val resolver =
      PanelUniqueIdResolver<FakeDisplay>(
        lookup = {
          lookups++
          { display -> display.id }
        },
        sdkInt = 35,
      )

    assertEquals("local:35", resolver.resolve(FakeDisplay("local:35")))
    assertEquals(1, lookups)
  }

  @Test
  fun `sdk 36 and 37 skip hidden unique id without reporting failures`() {
    for (sdk in listOf(36, 37)) {
      var lookups = 0
      var unavailable = 0
      var transientFailures = 0
      val resolver =
        PanelUniqueIdResolver<FakeDisplay>(
          lookup = {
            lookups++
            { display -> display.id }
          },
          onUnavailable = { unavailable++ },
          onTransientFailure = { transientFailures++ },
          sdkInt = sdk,
        )

      repeat(100) { assertNull(resolver.resolve(FakeDisplay("local:$sdk"))) }

      assertEquals(0, lookups)
      assertEquals(0, unavailable)
      assertEquals(0, transientFailures)
    }
  }

  @Test
  fun `repeated transient failures are logged once without disabling reads`() {
    var calls = 0
    val errors = mutableListOf<Throwable>()
    val failure = InvocationTargetException(IllegalArgumentException("temporary target failure"))
    val resolver =
      PanelUniqueIdResolver<FakeDisplay>(
        lookup = {
          { display ->
            calls++
            if (calls <= 100) throw failure
            display.id
          }
        },
        onTransientFailure = { errors.add(it) },
      )
    val display = FakeDisplay("local:1")
    repeat(100) { assertNull(resolver.resolve(display)) }
    assertEquals(listOf(failure), errors)
    assertEquals("local:1", resolver.resolve(display))
    assertEquals(101, calls)
  }

  @Test
  fun `denied lookup is cached and reported once`() {
    var lookups = 0
    val errors = mutableListOf<Throwable?>()
    val denial = NoSuchMethodException("getUniqueId")
    val resolver =
      PanelUniqueIdResolver<FakeDisplay>(
        lookup = {
          lookups++
          throw denial
        },
        onUnavailable = { errors.add(it) },
      )

    repeat(100) { assertNull(resolver.resolve(FakeDisplay("local:1"))) }

    assertEquals(1, lookups)
    assertEquals(1, errors.size)
    assertSame(denial, errors.single())
  }

  @Test
  fun `null lookup is cached and reported once`() {
    var lookups = 0
    val errors = mutableListOf<Throwable?>()
    val resolver =
      PanelUniqueIdResolver<FakeDisplay>(
        lookup = {
          lookups++
          null
        },
        onUnavailable = { errors.add(it) },
      )

    repeat(100) { assertNull(resolver.resolve(FakeDisplay("local:1"))) }

    assertEquals(1, lookups)
    assertEquals(1, errors.size)
    assertNull(errors.single())
  }

  @Test
  fun `accessor is resolved once but reads each display on every call`() {
    var lookups = 0
    var invocations = 0
    var unavailable = 0
    val resolver =
      PanelUniqueIdResolver<FakeDisplay>(
        lookup = {
          lookups++
          val read: (FakeDisplay) -> String? = { display ->
            invocations++
            display.id
          }
          read
        },
        onUnavailable = { unavailable++ },
      )
    val first = FakeDisplay("local:1")
    val second = FakeDisplay("local:2")

    repeat(100) { index ->
      val display = if (index % 2 == 0) first else second
      val expected = "local:$index"
      display.id = expected
      assertEquals(expected, resolver.resolve(display))
    }

    assertEquals(1, lookups)
    assertEquals(100, invocations)
    assertEquals(0, unavailable)
  }

  @Test
  fun `third access failure permanently disables the accessor`() {
    var lookups = 0
    var invocations = 0
    val errors = mutableListOf<Throwable?>()
    val denial = IllegalAccessException("getUniqueId")
    val resolver =
      PanelUniqueIdResolver<FakeDisplay>(
        lookup = {
          lookups++
          val read: (FakeDisplay) -> String? = { display ->
            invocations++
            if (invocations == 3) throw denial
            display.id
          }
          read
        },
        onUnavailable = { errors.add(it) },
      )
    val display = FakeDisplay("local:1")

    repeat(2) { assertEquals("local:1", resolver.resolve(display)) }
    repeat(100) { assertNull(resolver.resolve(display)) }

    assertEquals(1, lookups)
    assertEquals(3, invocations)
    assertEquals(1, errors.size)
    assertSame(denial, errors.single())
  }

  @Test
  fun `third transient invocation failure leaves the accessor available`() {
    var lookups = 0
    var invocations = 0
    var unavailable = 0
    val resolver =
      PanelUniqueIdResolver<FakeDisplay>(
        lookup = {
          lookups++
          val read: (FakeDisplay) -> String? = { display ->
            invocations++
            if (invocations == 3) throw InvocationTargetException(RuntimeException("temporary"))
            display.id
          }
          read
        },
        onUnavailable = { unavailable++ },
      )
    val display = FakeDisplay("local:1")
    repeat(2) { assertEquals("local:1", resolver.resolve(display)) }
    assertNull(resolver.resolve(display))
    assertEquals("local:1", resolver.resolve(display))
    assertEquals(1, lookups)
    assertEquals(4, invocations)
    assertEquals(0, unavailable)
  }

  @Test
  fun `wrapped access failures and linkage failures latch once`() {
    listOf(
        IllegalArgumentException("wrong receiver"),
        IllegalAccessException("denied"),
        SecurityException("denied"),
        LinkageError("denied"),
        InvocationTargetException(SecurityException("denied")),
        InvocationTargetException(LinkageError("denied")),
      )
      .forEach { failure ->
        var calls = 0
        var unavailable = 0
        val resolver =
          PanelUniqueIdResolver<FakeDisplay>(
            lookup = {
              { _ ->
                calls++
                throw failure
              }
            },
            onUnavailable = { unavailable++ },
          )
        repeat(4) { assertNull(resolver.resolve(FakeDisplay("local:1"))) }
        assertEquals(1, calls)
        assertEquals(1, unavailable)
      }
  }

  @Test
  fun `null display leaves lookup lazy`() {
    var lookups = 0
    var unavailable = 0
    val resolver =
      PanelUniqueIdResolver<FakeDisplay>(
        lookup = {
          lookups++
          null
        },
        onUnavailable = { unavailable++ },
      )

    repeat(100) { assertNull(resolver.resolve(null)) }

    assertEquals(0, lookups)
    assertEquals(0, unavailable)
    assertNull(resolver.resolve(FakeDisplay("local:1")))
    assertEquals(1, lookups)
    assertEquals(1, unavailable)
  }

  @Test
  fun `concurrent callers resolve the accessor once`() {
    val lookups = AtomicInteger()
    val invocations = AtomicInteger()
    val unavailable = AtomicInteger()
    val resolver =
      PanelUniqueIdResolver<FakeDisplay>(
        lookup = {
          lookups.incrementAndGet()
          val read: (FakeDisplay) -> String? = { display ->
            invocations.incrementAndGet()
            display.id
          }
          read
        },
        onUnavailable = { unavailable.incrementAndGet() },
      )
    val ready = CountDownLatch(8)
    val start = CountDownLatch(1)
    val executor = Executors.newFixedThreadPool(8)
    try {
      val results =
        (0 until 8).map { index ->
          executor.submit<List<String?>> {
            val display = FakeDisplay("local:$index")
            ready.countDown()
            check(start.await(30, TimeUnit.SECONDS))
            List(50) { resolver.resolve(display) }
          }
        }
      assertTrue(ready.await(30, TimeUnit.SECONDS))
      start.countDown()
      results.forEachIndexed { index, result ->
        assertEquals(List(50) { "local:$index" }, result.get(30, TimeUnit.SECONDS))
      }
      assertEquals(1, lookups.get())
      assertEquals(400, invocations.get())
      assertEquals(0, unavailable.get())
    } finally {
      start.countDown()
      executor.shutdownNow()
    }
  }
}
