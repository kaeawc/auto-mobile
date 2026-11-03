package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePurchaseOutcome.Error
import dev.jasonpearson.automobile.protocol.PrototypePurchaseOutcome.Outcome
import dev.jasonpearson.automobile.protocol.PrototypePurchaseOutcome.Product
import dev.jasonpearson.automobile.protocol.PrototypePurchaseOutcome.State
import dev.jasonpearson.automobile.protocol.PrototypePurchaseOutcome.Step
import dev.jasonpearson.automobile.protocol.PrototypePurchaseOutcome.Transaction
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory

/** The fake store reducer (#14314) replays the corpus the TypeScript reference replays. */
class PrototypePurchaseOutcomeTest {
  private fun corpus(): List<File> =
    File(fixtureDirectory().parentFile, "prototype-purchase")
      .listFiles { file -> file.extension == "json" }
      .orEmpty()
      .sortedBy { it.name }

  private fun JsonObject.text(key: String) = getValue(key).jsonPrimitive.content

  private fun JsonObject.textOrNull(key: String) = get(key)?.jsonPrimitive?.content

  private fun stateOf(json: JsonObject) =
    State(
      json.getValue("entitlements").jsonObject.mapValues { it.value.jsonPrimitive.content },
      (json["lastTransaction"] as? JsonObject)?.let {
        Transaction(it.text("transactionId"), it.text("productId"), it.text("status"))
      },
    )

  private fun outcomeOf(json: JsonObject): Outcome =
    (json["error"] as? JsonObject)?.let {
      Outcome.Failure(Error(it.text("code"), it.text("message"), it.textOrNull("reason")))
    }
      ?: json.getValue("result").jsonObject.let {
        Outcome.Result(it.text("status"), it.text("transactionId"))
      }

  private fun stateJson(state: State): JsonObject = buildJsonObject {
    put("entitlements", JsonObject(state.entitlements.mapValues { JsonPrimitive(it.value) }))
    put(
      "lastTransaction",
      state.lastTransaction?.let {
        buildJsonObject {
          put("transactionId", it.transactionId)
          put("productId", it.productId)
          put("status", it.status)
        }
      } ?: JsonNull,
    )
  }

  private fun stepJson(step: Step): JsonElement = buildJsonObject {
    put("state", stateJson(step.state))
    step.into?.let {
      put(
        "into",
        buildJsonObject {
          put("status", it.status)
          put("transactionId", it.transactionId)
        },
      )
    }
    step.error?.let {
      put(
        "error",
        buildJsonObject {
          put("code", it.code)
          put("message", it.message)
          it.reason?.let { reason -> put("reason", reason) }
        },
      )
    }
    put("entitlementsChanged", step.entitlementsChanged)
  }

  private fun apply(products: List<Product>, state: State, step: JsonObject): Step =
    when (val op = step.text("op")) {
      "purchase" ->
        PrototypePurchaseOutcome.purchase(
          products,
          state,
          step.text("productId"),
          outcomeOf(step.getValue("outcome").jsonObject),
        )
      "resolve" ->
        PrototypePurchaseOutcome.resolve(
          products,
          state,
          step.text("transactionId"),
          step.text("resolution"),
        )
      "entitlement" ->
        PrototypePurchaseOutcome.entitlementChange(
          products,
          state,
          step.text("productId"),
          step.text("change"),
        )
      else -> error("Unknown op $op")
    }

  @TestFactory
  fun `shared purchase corpus`(): List<DynamicTest> {
    val files = corpus()
    assertTrue(files.isNotEmpty(), "test/fixtures/prototype-purchase is empty")
    return files.map { file ->
      val fixture = Json.parseToJsonElement(file.readText()).jsonObject
      DynamicTest.dynamicTest("${file.name}: ${fixture.text("name")}") {
        val products =
          fixture.getValue("products").jsonArray.map {
            Product(it.jsonObject.text("id"), it.jsonObject.text("kind"))
          }
        fixture.getValue("steps").jsonArray.foldIndexed(
          stateOf(fixture.getValue("state").jsonObject),
        ) { index, state, raw ->
          val step = raw.jsonObject
          val result = apply(products, state, step)
          assertEquals(step.getValue("expect"), stepJson(result), "${file.name} step $index")
          result.state
        }
      }
    }
  }
}
