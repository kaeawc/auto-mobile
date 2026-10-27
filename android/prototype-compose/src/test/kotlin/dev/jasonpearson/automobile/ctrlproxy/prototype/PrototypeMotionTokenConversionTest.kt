package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.core.SpringSpec
import dev.jasonpearson.automobile.protocol.PrototypeMotionTokens
import org.junit.Assert.assertEquals
import org.junit.BeforeClass
import org.junit.Test

/** Conversion is pure: no Compose rule, Android context or Robolectric runtime. */
class PrototypeMotionTokenConversionTest {
  companion object {
    @BeforeClass
    @JvmStatic
    fun loadContract() {
      PrototypeMotionTokens.token()
    }
  }

  @Test
  fun conversionPreservesEveryToken() {
    for (scheme in listOf("standard", "expressive")) {
      for (role in listOf("spatial", "effects")) {
        for (tempo in listOf("fast", "default", "slow")) {
          val token = PrototypeMotionTokens.token(scheme, role, tempo)
          val spec = prototypeTokenSpec<Float>(scheme, role, tempo) as SpringSpec<Float>
          assertEquals(token.dampingRatio.toFloat(), spec.dampingRatio, 0f)
          assertEquals(token.stiffness.toFloat(), spec.stiffness, 0f)
        }
      }
    }
  }
}
