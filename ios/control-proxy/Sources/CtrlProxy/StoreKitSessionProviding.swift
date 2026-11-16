import Foundation

/// Current nondeprecated SKTestSession.TimeRate names (iOS 17 platform floor).
enum StoreKitTimeRate: String, CaseIterable, Sendable {
    case realTime
    case monthlyRenewalEveryHour
    case monthlyRenewalEveryThirtyMinutes
    case monthlyRenewalEveryFifteenMinutes
    case monthlyRenewalEveryFiveMinutes
    case monthlyRenewalEveryThirtySeconds
    case oneRenewalEveryFifteenMinutes
    case oneRenewalEveryFiveMinutes
    case oneRenewalEveryMinute
    case oneRenewalEveryThirtySeconds
    case oneRenewalEveryTenSeconds
    case oneRenewalEveryTwoSeconds
}

@MainActor
protocol StoreKitTestSessioning: AnyObject {
    var disableDialogs: Bool { get set }
    func resetToDefaultState()
    func clearTransactions()
    func buy(productId: String) async throws
    func refund(transactionId: Int) throws
    func expire(subscriptionId: String) throws
    func setTimeRate(_ rate: StoreKitTimeRate) throws
    func setSimulatedError(_ code: Int) async throws
    func allTransactions() -> [StoreKitTransaction]
}

protocol StoreKitSessionProviding: Sendable {
    @MainActor
    func execute(_ request: RequestStoreKit) async throws -> [StoreKitTransaction]?
}

/// Serializes session access on the main actor. The shared default outlives handlers
/// and WebSocket connections; tests inject a store with an in-memory factory.
@MainActor
final class StoreKitSessionStore: StoreKitSessionProviding {
    nonisolated static let shared = StoreKitSessionStore()
    private var busyBundles: Set<String> = []
    private var sessions: [String: any StoreKitTestSessioning] = [:]
    private let factory: @MainActor @Sendable (String) throws -> any StoreKitTestSessioning
    private let supported: Bool

    nonisolated init(
        supported: Bool = DefaultStoreKitTestSession.isSupported,
        factory: @escaping @MainActor @Sendable (String) throws -> any StoreKitTestSessioning = {
            try DefaultStoreKitTestSession.make(configPath: $0)
        }
    ) {
        self.supported = supported
        self.factory = factory
    }

    func execute(_ request: RequestStoreKit) async throws -> [StoreKitTransaction]? {
        guard supported else {
            throw VerbatimLocalizedError(message: "unsupported: StoreKitTest requires an iOS simulator runner")
        }
        _ = try required(request.bundleId, name: "bundleId")
        guard busyBundles.insert(request.bundleId).inserted else {
            throw VerbatimLocalizedError(
                message: "storekit operation in progress for bundleId; retry after it completes"
            )
        }
        defer { busyBundles.remove(request.bundleId) }
        if request.action == "load" {
            let path = try required(request.configPath, name: "configPath")
            guard path.hasPrefix("/"), URL(fileURLWithPath: path).pathExtension == "storekit" else {
                throw CommandError.invalidParameter("configPath", "expected an absolute .storekit path")
            }
            let session = try factory(path)
            session.resetToDefaultState()
            session.clearTransactions()
            session.disableDialogs = true
            sessions[request.bundleId] = session
            return nil
        }
        guard let session = sessions[request.bundleId] else {
            throw VerbatimLocalizedError(message: "no storekit session for bundleId; call load first")
        }
        return try await perform(request, session: session)
    }

    private func perform(_ request: RequestStoreKit, session: any StoreKitTestSessioning) async throws
        -> [StoreKitTransaction]?
    {
        switch request.action {
        case "buy":
            try await session.buy(productId: required(request.productId, name: "productId"))
        case "refund":
            guard let identifier = request.transactionId else { throw CommandError.missingParameter("transactionId") }
            guard identifier >= 0 else { throw CommandError.invalidParameter("transactionId", String(identifier)) }
            try session.refund(transactionId: identifier)
        case "expire":
            try session.expire(subscriptionId: required(request.subscriptionId, name: "subscriptionId"))
        case "clear":
            session.resetToDefaultState()
            session.clearTransactions()
            let transactions = session.allTransactions()
            sessions.removeValue(forKey: request.bundleId)
            return transactions
        case "list": break
        default:
            try await configure(request, session: session)
            return nil
        }
        return session.allTransactions()
    }

    private func configure(_ request: RequestStoreKit, session: any StoreKitTestSessioning) async throws {
        switch request.action {
        case "setTimeRate":
            let name = try required(request.timeRate, name: "timeRate")
            guard let rate = StoreKitTimeRate(rawValue: name) else {
                throw CommandError.invalidParameter("timeRate", name)
            }
            try session.setTimeRate(rate)
        case "setSimulatedError":
            guard let code = request.simulatedError else { throw CommandError.missingParameter("simulatedError") }
            guard [0, 2, 5].contains(code) else {
                throw CommandError.invalidParameter("simulatedError", String(code))
            }
            try await session.setSimulatedError(code)
        case "disableDialogs":
            guard let enabled = request.enabled else { throw CommandError.missingParameter("enabled") }
            session.disableDialogs = enabled
        default: throw CommandError.invalidParameter("action", request.action)
        }
    }

    private func required(_ value: String?, name: String) throws -> String {
        guard let value, !value.isEmpty else { throw CommandError.missingParameter(name) }
        return value
    }
}
