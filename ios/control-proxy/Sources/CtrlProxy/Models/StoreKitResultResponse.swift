import Foundation

public struct StoreKitTransaction: Codable, Sendable, Equatable {
    public let identifier: Int
    public let productId: String
    public let state: String
    public let originalIdentifier: Int?
}

public struct StoreKitResultResponse: Codable, Sendable {
    public let type: String
    public let requestId: String?
    public let success: Bool
    public let action: String
    public let bundleId: String
    public let error: String?
    public let transactions: [StoreKitTransaction]?
    public let totalTimeMs: Int64

    init(
        request: RequestStoreKit,
        success: Bool,
        error: String? = nil,
        transactions: [StoreKitTransaction]? = nil,
        totalTimeMs: Int64
    ) {
        type = ResponseType.storeKitResult.rawValue
        requestId = request.requestId
        self.success = success
        action = request.action
        bundleId = request.bundleId
        self.error = error
        self.transactions = transactions
        self.totalTimeMs = totalTimeMs
    }
}
