import Foundation
#if os(iOS) && canImport(StoreKitTest)
    import StoreKit
    import StoreKitTest
#endif

/// StoreKitTest stays out of macOS SwiftPM builds and real-device execution.
enum DefaultStoreKitTestSession {
    static var isSupported: Bool {
        #if os(iOS) && canImport(StoreKitTest) && targetEnvironment(simulator)
            true
        #else
            false
        #endif
    }

    @MainActor
    static func make(configPath: String) throws -> any StoreKitTestSessioning {
        #if os(iOS) && canImport(StoreKitTest) && targetEnvironment(simulator)
            return try SimulatorStoreKitTestSession(configPath: configPath)
        #else
            throw VerbatimLocalizedError(message: "unsupported: StoreKitTest requires an iOS simulator runner")
        #endif
    }
}

#if os(iOS) && canImport(StoreKitTest)
    #if targetEnvironment(simulator)
        @MainActor
        private final class SimulatorStoreKitTestSession: StoreKitTestSessioning {
            private let session: SKTestSession
            private var simulatedPurchaseError = false

            init(configPath: String) throws {
                session = try SKTestSession(contentsOf: URL(fileURLWithPath: configPath))
            }

            var disableDialogs: Bool {
                get { session.disableDialogs }
                set { session.disableDialogs = newValue }
            }

            func resetToDefaultState() {
                session.resetToDefaultState()
                simulatedPurchaseError = false
            }

            func clearTransactions() { session.clearTransactions() }

            func buy(productId: String) async throws {
                do {
                    try buySynchronously(productId: productId)
                } catch {
                    try await clearPurchaseError()
                    throw error
                }
                try await clearPurchaseError()
            }

            /// The async `buyProduct(identifier:)` reports "Unable to Complete Request" in a runner
            /// process with no app context even though it records the transaction, and the
            /// synchronous form the spike verified is deprecated (an error under the strict warning
            /// flags), so reach it through its ObjC selector `buyProductWithIdentifier:error:`.
            private func buySynchronously(productId: String) throws {
                typealias Buy = @convention(c) (
                    AnyObject, Selector, NSString, UnsafeMutablePointer<Unmanaged<NSError>?>?
                )
                    -> Bool
                let selector = NSSelectorFromString("buyProductWithIdentifier:error:")
                guard let imp = session.method(for: selector) else {
                    throw VerbatimLocalizedError(message: "unsupported: SKTestSession buyProduct is unavailable")
                }
                var failure: Unmanaged<NSError>?
                let bought = unsafeBitCast(imp, to: Buy.self)(session, selector, productId as NSString, &failure)
                if !bought {
                    let reason: any Error = failure?.takeUnretainedValue()
                        ?? VerbatimLocalizedError(message: "SKTestSession buyProduct failed")
                    throw reason
                }
            }

            private func clearPurchaseError() async throws {
                if simulatedPurchaseError {
                    try await session.setSimulatedError(nil, forAPI: .purchase)
                    simulatedPurchaseError = false
                }
            }

            func refund(transactionId: Int) throws {
                try session.refundTransaction(identifier: UInt(transactionId))
            }

            func expire(subscriptionId: String) throws {
                try session.expireSubscription(productIdentifier: subscriptionId)
            }

            func setTimeRate(_ rate: StoreKitTimeRate) {
                switch rate {
                case .realTime: session.timeRate = .realTime
                case .monthlyRenewalEveryHour: session.timeRate = .monthlyRenewalEveryHour
                case .monthlyRenewalEveryThirtyMinutes: session.timeRate = .monthlyRenewalEveryThirtyMinutes
                case .monthlyRenewalEveryFifteenMinutes: session.timeRate = .monthlyRenewalEveryFifteenMinutes
                case .monthlyRenewalEveryFiveMinutes: session.timeRate = .monthlyRenewalEveryFiveMinutes
                case .monthlyRenewalEveryThirtySeconds: session.timeRate = .monthlyRenewalEveryThirtySeconds
                case .oneRenewalEveryFifteenMinutes: session.timeRate = .oneRenewalEveryFifteenMinutes
                case .oneRenewalEveryFiveMinutes: session.timeRate = .oneRenewalEveryFiveMinutes
                case .oneRenewalEveryMinute: session.timeRate = .oneRenewalEveryMinute
                case .oneRenewalEveryThirtySeconds: session.timeRate = .oneRenewalEveryThirtySeconds
                case .oneRenewalEveryTenSeconds: session.timeRate = .oneRenewalEveryTenSeconds
                case .oneRenewalEveryTwoSeconds: session.timeRate = .oneRenewalEveryTwoSeconds
                }
            }

            func setSimulatedError(_ code: Int) async throws {
                let failure: SKTestFailures.Purchase
                switch code {
                case 0: failure = .generic(.unknown)
                case 2: failure = .generic(.userCancelled)
                case 5: failure = .generic(.notAvailableInStorefront)
                default: throw CommandError.invalidParameter("simulatedError", String(code))
                }
                try await session.setSimulatedError(failure, forAPI: .purchase)
                simulatedPurchaseError = true
            }

            func allTransactions() -> [StoreKitTransaction] {
                session.allTransactions().map {
                    StoreKitTransaction(
                        identifier: Int($0.identifier),
                        productId: $0.productIdentifier,
                        state: Self.stateName($0.state),
                        originalIdentifier: $0.originalTransactionIdentifier == 0
                            ? nil : Int($0.originalTransactionIdentifier)
                    )
                }
            }

            private static func stateName(_ state: SKPaymentTransactionState) -> String {
                switch state {
                case .purchased: "purchased"
                case .purchasing: "purchasing"
                case .failed: "failed"
                case .restored: "restored"
                case .deferred: "deferred"
                @unknown default: "unknown"
                }
            }
        }
    #endif
#endif
