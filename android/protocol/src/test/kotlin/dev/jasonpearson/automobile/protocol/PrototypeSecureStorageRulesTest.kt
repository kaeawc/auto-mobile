package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class PrototypeSecureStorageRulesTest {
  companion object {
    @JvmStatic
    @BeforeAll
    fun warm() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private fun spec(action: String) =
    """{
      "id":"secure-routes","window":{"placement":{"type":"fullscreen"}},
      "requires":{"platform":["secureStorage","share"]},
      "state":{"token":"","public":"hello"},
      "storage":{"version":1,"keys":["stack:nav"],"secure":["state:token"]},
      "root":{"type":"stack","id":"nav","start":"home","screens":{
        "home":{"type":"button","label":"Go","onTap":[$action]},
        "detail":{"type":"text","text":"Detail"}},
        "routes":{"detail":{"params":{"t":"string"}}}}
    }"""

  private fun navigation(type: String, binding: String): String =
    if (type == "setStack")
      """{"type":"setStack","stack":"nav","path":[{"screen":"home"},{"screen":"detail","params":{"t":$binding}}]}"""
    else """{"type":"$type","stack":"nav","screen":"detail","params":{"t":$binding}}"""

  private fun paramPath(type: String) =
    "root.screens[\"home\"].onTap[0]." + if (type == "setStack") "path[1].params.t" else "params.t"

  @TestFactory
  fun secureNavigationBindings(): List<DynamicTest> =
    listOf("push", "replace", "setStack").map { type ->
      DynamicTest.dynamicTest("$type refuses secure state at accept time") {
        assertEquals(
          PrototypeSpecValidation.Failure(
            PrototypeSpecError(
              paramPath(type),
              "Secure storage key state:token cannot be sent in route params",
            ),
          ),
          PrototypeSpecValidator.validate(spec(navigation(type, """{"state":"token"}"""))),
        )
      }
    }

  @TestFactory
  fun ordinaryNavigationBindings(): List<DynamicTest> =
    listOf("push", "replace", "setStack").flatMap { type ->
      // Route params take scalars and state/item/index/data bindings, so a literal "{token}" is
      // the only way to carry placeholder text; the {"value":...} form is platform args only.
      listOf("""{"state":"public"}""", """"{token}"""").map { binding ->
        DynamicTest.dynamicTest("$type accepts $binding without expanding state placeholders") {
          val result = PrototypeSpecValidator.validate(spec(navigation(type, binding)))
          assertTrue(result is PrototypeSpecValidation.Success, result.toString())
        }
      }
    }

  @Test
  fun platformArgsRefuseSecureStateAtAcceptTime() {
    assertEquals(
      PrototypeSpecValidation.Failure(
        PrototypeSpecError(
          "root.screens[\"home\"].onTap[0].args.text",
          "Secure storage key state:token cannot be sent in platform args",
        ),
      ),
      PrototypeSpecValidator.validate(
        spec("""{"type":"platform","call":"share.open","args":{"text":{"state":"token"}}}"""),
      ),
    )
  }

  @Test
  fun derivedBindingsPreserveSecureStorageRestrictions() {
    val derive =
      Json.parseToJsonElement("""{"secret":{"of":{"state":"token"},"format":{"number":{}}}}""")
    fun result(action: String): PrototypeSpecValidation {
      val spec = Json.parseToJsonElement(spec(action)).jsonObject
      return PrototypeSpecValidator.validate(JsonObject(spec + ("derive" to derive)).toString())
    }
    val base = "root.screens[\"home\"].onTap[0]"
    val emit = """{"type":"emit","name":"token","context":{"token":{"derived":"secret"}}}"""
    assertEquals(
      PrototypeSpecValidation.Failure(
        PrototypeSpecError(
          "$base.context.token",
          "Secure storage key state:token cannot be sent in an emit context",
        ),
      ),
      result(emit),
    )
    val request =
      """{"type":"request","url":"https://example.com","query":{"token":{"derived":"secret"}}}"""
    assertEquals(
      PrototypeSpecValidation.Failure(
        PrototypeSpecError(
          "$base.query.token",
          "Secure storage key state:token cannot be sent in a request without allowSecureInRequest",
        ),
      ),
      result(request),
    )
    assertTrue(
      result(request.dropLast(1) + ""","allowSecureInRequest":true}""")
        is PrototypeSpecValidation.Success,
    )
  }

  /** #19013: route params and platform args resolve derived bindings like emit and request. */
  @TestFactory
  fun derivedBindingsCannotReachRouteParamsOrPlatformArgs(): List<DynamicTest> {
    val root =
      Json.parseToJsonElement(
          """{"storage":{"secure":["state:token"]},"derive":{
            "secret":{"of":{"state":"token"},"format":{"number":{}}},
            "matching":{"collection":{"of":{"data":"/rows"},
              "where":[{"field":"t","op":"eq","value":{"state":"token"}}]},"reduce":{"op":"count"}},
            "open":{"of":{"state":"public"},"format":{"number":{}}}}}""",
        )
        .jsonObject
    fun error(action: String) =
      PrototypeSecureStorageRules.actionError(
        Json.parseToJsonElement(action).jsonObject,
        "root.onTap[0]",
        root,
      )
    return listOf("secret", "matching").flatMap { name ->
      val binding = """{"derived":"$name"}"""
      listOf(
          """{"type":"push","params":{"t":$binding}}""" to
            PrototypeSpecError(
              "root.onTap[0].params.t",
              "Secure storage key state:token cannot be sent in route params",
            ),
          """{"type":"setStack","path":[{"screen":"detail","params":{"t":$binding}}]}""" to
            PrototypeSpecError(
              "root.onTap[0].path[0].params.t",
              "Secure storage key state:token cannot be sent in route params",
            ),
          """{"type":"platform","args":{"text":$binding}}""" to
            PrototypeSpecError(
              "root.onTap[0].args.text",
              "Secure storage key state:token cannot be sent in platform args",
            ),
        )
        .map { (action, expected) ->
          DynamicTest.dynamicTest("$name: $action") {
            assertEquals(expected, error(action))
            assertNull(error(action.replace("\"$name\"", "\"open\"")))
          }
        }
    }
  }

  @Test
  fun contractHasNoDerivedFormForRouteParamsOrPlatformArgs() {
    val derive =
      Json.parseToJsonElement("""{"secret":{"of":{"state":"token"},"format":{"number":{}}}}""")
    val action = """{"type":"platform","call":"share.open","args":{"text":{"derived":"secret"}}}"""
    val spec = Json.parseToJsonElement(spec(action)).jsonObject
    val result = PrototypeSpecValidator.validate(JsonObject(spec + ("derive" to derive)).toString())
    assertTrue(result is PrototypeSpecValidation.Failure, result.toString())
  }

  @TestFactory
  fun ordinaryPlatformArgs(): List<DynamicTest> =
    listOf("""{"state":"public"}""", """{"value":"{token}"}""").map { binding ->
      DynamicTest.dynamicTest("platform args accept $binding") {
        val result =
          PrototypeSpecValidator.validate(
            spec("""{"type":"platform","call":"share.open","args":{"text":$binding}}"""),
          )
        assertTrue(result is PrototypeSpecValidation.Success, result.toString())
      }
    }

  @TestFactory
  fun repeatTemplatesCannotSelectSecureState(): List<DynamicTest> =
    listOf("push", "replace", "setStack", "platform").map { type ->
      DynamicTest.dynamicTest("$type refuses a repeat template that can read token") {
        val action =
          if (type == "platform")
            """{"type":"platform","call":"share.open","args":{"text":{"state":"tok{row.id}"}}}"""
          else navigation(type, """{"state":"tok{row.id}"}""")
        val root = Json.parseToJsonElement(spec(action)).jsonObject
        val at = "root.screens[\"home\"].onTap[0]"
        val error =
          PrototypeSecureStorageRules.actionError(
            Json.parseToJsonElement(action).jsonObject,
            at,
            root,
          )
        assertEquals(if (type == "platform") "$at.args.text" else paramPath(type), error?.path)
        assertTrue(checkNotNull(error).message.contains("state:token"))
      }
    }
}
