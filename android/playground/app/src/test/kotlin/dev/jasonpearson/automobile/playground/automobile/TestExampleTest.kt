package dev.jasonpearson.automobile.playground.automobile

import dev.jasonpearson.automobile.junit.AutoMobilePlan
import org.junit.Assert.assertTrue
import org.junit.Test

class TestExampleTest {
  @Test
  fun testExample() {
    val result = AutoMobilePlan("test-plan.yaml").execute()
    assertTrue(result.success)
  }
}
