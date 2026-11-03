package dev.jasonpearson.automobile.protocol

/**
 * The fake store's reducer (#14314), the Kotlin twin of TypeScript's
 * `src/features/prototype/prototypePurchaseOutcome.ts`. Both replay
 * `test/fixtures/prototype-purchase/`.
 *
 * `entitlements` maps a product id to `active`, `gracePeriod` or `billingRetry` (a consumable never
 * holds one); `lastTransaction` is the last `commerce.purchase` result. A product that is `active`
 * or in `gracePeriod` is `alreadyOwned`; a queued error leaves the state untouched;
 * `entitlementsChanged` is true only when the entitlements really changed.
 */
object PrototypePurchaseOutcome {
  val statuses = listOf("purchased", "deferred", "pending")
  val errorCodes = listOf("cancelled", "alreadyOwned", "platform_error")
  val errorReasons = listOf("network", "declined", "unavailable")
  val entitlementChanges = listOf("renew", "expire", "refund", "gracePeriod", "billingRetry")

  private const val MAX_TRANSACTION_ID_LENGTH = 64

  /** What the reducer reads from a catalog product; `kind` is the catalog kind. */
  data class Product(val id: String, val kind: String)

  data class Transaction(val transactionId: String, val productId: String, val status: String)

  data class State(
    val entitlements: Map<String, String> = emptyMap(),
    val lastTransaction: Transaction? = null,
  )

  data class Error(val code: String, val message: String, val reason: String? = null)

  /** One `commerce.purchase` outcome: a `result` status and transaction id, or an `error`. */
  sealed interface Outcome {
    data class Result(val status: String, val transactionId: String) : Outcome

    data class Failure(val error: Error) : Outcome
  }

  data class Into(val status: String, val transactionId: String)

  data class Step(
    val state: State,
    val into: Into? = null,
    val error: Error? = null,
    val entitlementsChanged: Boolean = false,
  )

  private fun failed(state: State, error: Error) = Step(state, error = error)

  private fun unknownProduct(state: State, productId: String) =
    failed(state, Error("platform_error", "Unknown product $productId", "unavailable"))

  private fun typedError(error: Error): Error {
    val code = if (error.code in errorCodes) error.code else "platform_error"
    val reason = error.reason?.takeIf { code == "platform_error" && it in errorReasons }
    return Error(code, error.message, reason)
  }

  private fun isOwned(state: State, productId: String): Boolean =
    state.entitlements[productId].let { it == "active" || it == "gracePeriod" }

  private fun withEntitlement(
    state: State,
    productId: String,
    status: String?,
    lastTransaction: Transaction? = state.lastTransaction,
  ): Step {
    val previous = state.entitlements[productId]
    val entitlements =
      when {
        status == previous -> state.entitlements
        status == null -> state.entitlements - productId
        else -> state.entitlements + (productId to status)
      }
    return Step(State(entitlements, lastTransaction), entitlementsChanged = status != previous)
  }

  /** Applies one `commerce.purchase` outcome for [productId] against the catalog [products]. */
  fun purchase(products: List<Product>, state: State, productId: String, outcome: Outcome): Step {
    val product =
      products.firstOrNull { it.id == productId } ?: return unknownProduct(state, productId)
    if (product.kind != "consumable" && isOwned(state, productId))
      return failed(state, Error("alreadyOwned", "$productId is already owned"))
    val result =
      when (outcome) {
        is Outcome.Failure -> return failed(state, typedError(outcome.error))
        is Outcome.Result -> outcome
      }
    if (result.transactionId.isEmpty() || result.transactionId.length > MAX_TRANSACTION_ID_LENGTH)
      return failed(state, Error("platform_error", "Invalid transaction id"))
    val lastTransaction = Transaction(result.transactionId, productId, result.status)
    val step =
      if (result.status == "purchased" && product.kind != "consumable")
        withEntitlement(state, productId, "active", lastTransaction)
      else Step(state.copy(lastTransaction = lastTransaction))
    return step.copy(into = Into(result.status, result.transactionId))
  }

  /** Resolves the open `deferred` or `pending` transaction: `approved` or `declined`. */
  fun resolve(
    products: List<Product>,
    state: State,
    transactionId: String,
    resolution: String,
  ): Step {
    val open = state.lastTransaction
    if (
      open?.transactionId != transactionId ||
        (open.status != "deferred" && open.status != "pending")
    )
      return failed(state, Error("platform_error", "No open transaction $transactionId"))
    val product =
      products.firstOrNull { it.id == open.productId }
        ?: return unknownProduct(state, open.productId)
    if (resolution == "declined")
      return Step(state.copy(lastTransaction = open.copy(status = "declined")))
    val lastTransaction = open.copy(status = "purchased")
    return if (product.kind == "consumable") Step(state.copy(lastTransaction = lastTransaction))
    else withEntitlement(state, open.productId, "active", lastTransaction)
  }

  private val changeStatus =
    mapOf("renew" to "active", "gracePeriod" to "gracePeriod", "billingRetry" to "billingRetry")

  /** Applies one simulated `commerce.entitlementsChanged` [change] to [productId]. */
  fun entitlementChange(
    products: List<Product>,
    state: State,
    productId: String,
    change: String,
  ): Step {
    val product =
      products.firstOrNull { it.id == productId } ?: return unknownProduct(state, productId)
    if (product.kind == "consumable")
      return failed(
        state,
        Error("platform_error", "$productId is a consumable and has no entitlement"),
      )
    val status = changeStatus[change]
    if (status != null && product.kind != "subscription")
      return failed(state, Error("platform_error", "Only a subscription can $change"))
    if (status != null && productId !in state.entitlements)
      return failed(state, Error("platform_error", "$productId is not held"))
    return withEntitlement(state, productId, status)
  }
}
