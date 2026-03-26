package dev.jasonpearson.automobile.playground.automobile

import dev.jasonpearson.automobile.junit.AutoMobilePlan
import org.junit.Assert.assertTrue
import org.junit.Test

class TestBinaryExampleTest {
  @Test
  fun testBinaryExample() {
    val result = AutoMobilePlan("test-plans/test-plan.yaml").execute()
    assertTrue(result.success)
  }
}
