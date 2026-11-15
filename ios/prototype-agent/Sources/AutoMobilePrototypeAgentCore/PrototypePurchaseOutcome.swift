/// The fake store reducer, the Swift twin of `prototypePurchaseOutcome.ts` and Kotlin's
/// `PrototypePurchaseOutcome`. All replay `test/fixtures/prototype-purchase/`.
enum PrototypePurchaseOutcome {
    static let statuses = ["purchased", "deferred", "pending"]
    static let errorCodes = ["cancelled", "alreadyOwned", "platform_error"]
    static let errorReasons = ["network", "declined", "unavailable"]
    static let entitlementChanges = ["renew", "expire", "refund", "gracePeriod", "billingRetry"]

    private static let maxTransactionIdLength = 64
    private static let changeStatus = [
        "renew": "active", "gracePeriod": "gracePeriod", "billingRetry": "billingRetry",
    ]

    struct Product: Equatable, Sendable {
        let id: String
        let kind: String
    }

    struct Transaction: Equatable, Sendable {
        let transactionId: String
        let productId: String
        let status: String
    }

    struct State: Equatable, Sendable {
        // Dictionary lookups only inspect stored keys, including ids such as `constructor`.
        var entitlements: [String: String] = [:]
        var lastTransaction: Transaction?
    }

    struct Error: Equatable, Sendable {
        let code: String
        let message: String
        var reason: String?
    }

    enum Outcome: Equatable, Sendable {
        case result(status: String, transactionId: String)
        case failure(Error)
    }

    struct Into: Equatable, Sendable {
        let status: String
        let transactionId: String
    }

    struct Step: Equatable, Sendable {
        var state: State
        var into: Into?
        var error: Error?
        var entitlementsChanged = false
    }

    private static func failed(_ state: State, _ error: Error) -> Step {
        Step(state: state, error: error)
    }

    private static func unknownProduct(_ state: State, _ productId: String) -> Step {
        failed(state, Error(code: "platform_error", message: "Unknown product \(productId)", reason: "unavailable"))
    }

    private static func typedError(_ error: Error) -> Error {
        let code = errorCodes.contains(error.code) ? error.code : "platform_error"
        let reason = code == "platform_error" && errorReasons.contains(error.reason ?? "") ? error.reason : nil
        return Error(code: code, message: error.message, reason: reason)
    }

    private static func isOwned(_ state: State, _ productId: String) -> Bool {
        let status = state.entitlements[productId]
        return status == "active" || status == "gracePeriod"
    }

    private static func withEntitlement(
        _ state: State, _ productId: String, _ status: String?, _ lastTransaction: Transaction?
    )
        -> Step
    {
        let changed = state.entitlements[productId] != status
        var next = state
        if changed { next.entitlements[productId] = status }
        next.lastTransaction = lastTransaction
        return Step(state: next, entitlementsChanged: changed)
    }

    /// Applies one queued or tapped `commerce.purchase` outcome.
    static func purchase(_ products: [Product], _ state: State, _ productId: String, _ outcome: Outcome) -> Step {
        guard let product = products.first(where: { $0.id == productId }) else {
            return unknownProduct(state, productId)
        }
        if product.kind != "consumable", isOwned(state, productId) {
            return failed(state, Error(code: "alreadyOwned", message: "\(productId) is already owned"))
        }
        switch outcome {
        case let .failure(error):
            return failed(state, typedError(error))
        case let .result(status, transactionId):
            // TypeScript and Kotlin measure UTF-16 code units, not Swift grapheme clusters.
            guard !transactionId.isEmpty, transactionId.utf16.count <= maxTransactionIdLength else {
                return failed(state, Error(code: "platform_error", message: "Invalid transaction id"))
            }
            let transaction = Transaction(transactionId: transactionId, productId: productId, status: status)
            var step: Step
            if status == "purchased", product.kind != "consumable" {
                step = withEntitlement(state, productId, "active", transaction)
            } else {
                var next = state
                next.lastTransaction = transaction
                step = Step(state: next)
            }
            step.into = Into(status: status, transactionId: transactionId)
            return step
        }
    }

    /// Resolves the open `deferred` or `pending` transaction: `approved` or `declined`.
    static func resolve(
        _ products: [Product], _ state: State, _ transactionId: String, _ resolution: String
    )
        -> Step
    {
        guard let open = state.lastTransaction, open.transactionId == transactionId,
              open.status == "deferred" || open.status == "pending"
        else {
            return failed(state, Error(code: "platform_error", message: "No open transaction \(transactionId)"))
        }
        guard let product = products.first(where: { $0.id == open.productId }) else {
            return unknownProduct(state, open.productId)
        }
        let transaction = Transaction(
            transactionId: open.transactionId, productId: open.productId,
            status: resolution == "declined" ? "declined" : "purchased"
        )
        if resolution == "declined" || product.kind == "consumable" {
            var next = state
            next.lastTransaction = transaction
            return Step(state: next)
        }
        return withEntitlement(state, open.productId, "active", transaction)
    }

    /// Applies a simulated `commerce.entitlementsChanged`; only real changes raise the flag.
    static func entitlementChange(
        _ products: [Product], _ state: State, _ productId: String, _ change: String
    )
        -> Step
    {
        guard let product = products.first(where: { $0.id == productId }) else {
            return unknownProduct(state, productId)
        }
        if product.kind == "consumable" {
            return failed(
                state,
                Error(code: "platform_error", message: "\(productId) is a consumable and has no entitlement")
            )
        }
        let status = changeStatus[change]
        if status != nil, product.kind != "subscription" {
            return failed(state, Error(code: "platform_error", message: "Only a subscription can \(change)"))
        }
        if status != nil, state.entitlements[productId] == nil {
            return failed(state, Error(code: "platform_error", message: "\(productId) is not held"))
        }
        return withEntitlement(state, productId, status, state.lastTransaction)
    }
}
