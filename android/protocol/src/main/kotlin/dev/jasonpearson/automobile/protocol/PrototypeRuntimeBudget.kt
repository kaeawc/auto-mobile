package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The limits one runtime validates a spec against (#18804). The overlay and any runtime without a
 * budget capability use [BASE], the contract `limits`; an activity-hosted runtime advertising
 * [LARGE_BUDGET_CAPABILITY] uses [LARGE], the contract `runtimeBudgets` entry of that name. Every
 * other limit is the same in every runtime.
 */
data class PrototypeRuntimeBudget(
  val maxSpecBytes: Int,
  val maxDataBytes: Int,
  val maxDataWriteBytes: Int,
  val maxDataArrayItems: Int,
  val maxListItems: Int,
) {
  /** This budget's value of a contract limit name, or null when no budget can raise it. */
  fun limit(name: String): Int? =
    when (name) {
      "MAX_PROTOTYPE_SPEC_BYTES" -> maxSpecBytes
      "MAX_PROTOTYPE_DATA_BYTES" -> maxDataBytes
      "MAX_PROTOTYPE_DATA_WRITE_BYTES" -> maxDataWriteBytes
      "MAX_PROTOTYPE_DATA_ARRAY_ITEMS" -> maxDataArrayItems
      "MAX_PROTOTYPE_LIST_ITEMS" -> maxListItems
      else -> null
    }

  companion object {
    const val LARGE_BUDGET_CAPABILITY = "prototype_large_budget_v1"

    val BASE: PrototypeRuntimeBudget = from(PrototypeSpecContract.limits)

    val LARGE: PrototypeRuntimeBudget =
      from(
        PrototypeSpecContract.contract
          .getValue("runtimeBudgets")
          .jsonObject
          .getValue(LARGE_BUDGET_CAPABILITY)
          .jsonObject,
      )

    /** The budget of a runtime advertising [capabilities]; none is [BASE]. */
    fun forCapabilities(capabilities: Set<String>?): PrototypeRuntimeBudget =
      if (capabilities?.contains(LARGE_BUDGET_CAPABILITY) == true) LARGE else BASE

    private fun from(limits: JsonObject): PrototypeRuntimeBudget {
      fun value(name: String) = limits.getValue(name).jsonPrimitive.int
      return PrototypeRuntimeBudget(
        maxSpecBytes = value("MAX_PROTOTYPE_SPEC_BYTES"),
        maxDataBytes = value("MAX_PROTOTYPE_DATA_BYTES"),
        maxDataWriteBytes = value("MAX_PROTOTYPE_DATA_WRITE_BYTES"),
        maxDataArrayItems = value("MAX_PROTOTYPE_DATA_ARRAY_ITEMS"),
        maxListItems = value("MAX_PROTOTYPE_LIST_ITEMS"),
      )
    }
  }
}
