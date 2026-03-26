package dev.jasonpearson.automobile.playground.automobile

import dev.jasonpearson.automobile.junit.AutoMobilePlan
import org.junit.Assert.assertTrue
import org.junit.Test

class TestPlaygroundMainTest {
  @Test
  fun testPlaygroundMain() {
    val result = AutoMobilePlan("test-plan.yaml").execute()
    assertTrue(result.success)
  }
}
