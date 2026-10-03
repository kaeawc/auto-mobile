package dev.jasonpearson.automobile.junit

import org.junit.After
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Test

class LazyInitializerTest {
  @Before
  fun setUp() {
    LazyInitializer.clear()
  }

  @After
  fun tearDown() {
    LazyInitializer.clear()
  }

  @Test
  fun `getAgent returns the same instance twice`() {
    val agent = LazyInitializer.getAgent()

    assertSame(agent, LazyInitializer.getAgent())
  }

  @Test
  fun `clear makes getAgent create a fresh cached instance`() {
    val agent = LazyInitializer.getAgent()

    LazyInitializer.clear()
    val freshAgent = LazyInitializer.getAgent()

    assertNotSame(agent, freshAgent)
    assertSame(freshAgent, LazyInitializer.getAgent())
  }
}
