import Foundation

extension CommandHandler {
    func handleStoreKit(_ request: RequestStoreKit, startTime: Date) async -> StoreKitResultResponse {
        do {
            let transactions = try await storeKitSessions.execute(request)
            return StoreKitResultResponse(
                request: request,
                success: true,
                transactions: transactions,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        } catch {
            return StoreKitResultResponse(
                request: request,
                success: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }
}
