package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeScalar
import org.junit.Assert.assertEquals
import org.junit.Test

class PrototypeScalarTextTest {
  @Test
  fun `integral numbers print every digit with no decimal point exponent or negative zero`() {
    val cases =
      mapOf(
        0.0 to "0",
        -0.0 to "0",
        3.0 to "3",
        -5.0 to "-5",
        12_345_678.0 to "12345678",
        999_999_999_999_999.0 to "999999999999999",
        1e15 to "1000000000000000",
        1e21 to "1000000000000000000000",
        -1e21 to "-1000000000000000000000",
      )
    cases.forEach { (value, expected) -> assertEquals(expected, prototypeNumberText(value)) }
  }

  // Expected strings are the host's `renderScalar` output (JavaScript `String(number)`), captured
  // from `src/features/prototype/prototypeTemplate.ts` for the same doubles.
  @Test
  fun `non-integral numbers print as the host's JavaScript does`() {
    val cases =
      mapOf(
        0.1 to "0.1",
        1.5 to "1.5",
        -2.5 to "-2.5",
        100.5 to "100.5",
        4.35 to "4.35",
        123_456_789.125 to "123456789.125",
        0.1 + 0.2 to "0.30000000000000004",
        1.0 / 3.0 to "0.3333333333333333",
        0.00001 to "0.00001",
        0.000001 to "0.000001",
        0.000001234 to "0.000001234",
        1e-7 to "1e-7",
        2.5e-7 to "2.5e-7",
        -1.5e-7 to "-1.5e-7",
        1.2345e-10 to "1.2345e-10",
        Double.MIN_VALUE to "5e-324",
      )
    cases.forEach { (value, expected) -> assertEquals(expected, prototypeNumberText(value)) }
  }

  @Test
  fun `text and booleans render as themselves`() {
    assertEquals("{a}", PrototypeScalar.Text("{a}").renderedText())
    assertEquals("true", PrototypeScalar.BooleanValue(true).renderedText())
    assertEquals("0.00001", PrototypeScalar.Numeric(0.00001).renderedText())
  }
}
