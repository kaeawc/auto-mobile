import Foundation

protocol FailureResponse {
    static func failure(requestId: String?, error: String, totalTimeMs: Int64?) -> Self
}

struct VerbatimLocalizedError: LocalizedError, Sendable {
    let message: String

    var errorDescription: String? { message }
}

extension ExecuteSqlResponse: FailureResponse {
    static func failure(requestId: String?, error: String, totalTimeMs: Int64?) -> Self {
        Self(requestId: requestId, success: false, error: error, totalTimeMs: totalTimeMs)
    }
}

extension ListDatabasesResponse: FailureResponse {
    static func failure(requestId: String?, error: String, totalTimeMs: Int64?) -> Self {
        Self(requestId: requestId, success: false, error: error, totalTimeMs: totalTimeMs)
    }
}

extension StorageCapabilitiesResponse: FailureResponse {
    static func failure(requestId: String?, error: String, totalTimeMs: Int64?) -> Self {
        Self(requestId: requestId, success: false, error: error, totalTimeMs: totalTimeMs)
    }
}

extension ListTablesResponse: FailureResponse {
    static func failure(requestId: String?, error: String, totalTimeMs: Int64?) -> Self {
        Self(requestId: requestId, success: false, error: error, totalTimeMs: totalTimeMs)
    }
}

extension TableDataResponse: FailureResponse {
    static func failure(requestId: String?, error: String, totalTimeMs: Int64?) -> Self {
        Self(requestId: requestId, success: false, error: error, totalTimeMs: totalTimeMs)
    }
}

extension TableStructureResponse: FailureResponse {
    static func failure(requestId: String?, error: String, totalTimeMs: Int64?) -> Self {
        Self(requestId: requestId, success: false, error: error, totalTimeMs: totalTimeMs)
    }
}

extension StorageFilesResponse: FailureResponse {
    static func failure(requestId: String?, error: String, totalTimeMs: Int64?) -> Self {
        Self(requestId: requestId, success: false, error: error, totalTimeMs: totalTimeMs)
    }
}

extension StorageEntriesResponse: FailureResponse {
    static func failure(requestId: String?, error: String, totalTimeMs: Int64?) -> Self {
        Self(requestId: requestId, success: false, error: error, totalTimeMs: totalTimeMs)
    }
}

extension StorageEntryResponse: FailureResponse {
    static func failure(requestId: String?, error: String, totalTimeMs: Int64?) -> Self {
        Self(requestId: requestId, success: false, found: false, error: error, totalTimeMs: totalTimeMs)
    }
}

extension VoiceOverSetResponse: FailureResponse {
    static func failure(requestId: String?, error: String, totalTimeMs: Int64?) -> Self {
        Self(requestId: requestId, success: false, error: error, totalTimeMs: totalTimeMs)
    }
}

extension HingeAngleResponse: FailureResponse {
    static func failure(requestId: String?, error: String, totalTimeMs: Int64?) -> Self {
        Self(requestId: requestId, success: false, error: error, totalTimeMs: totalTimeMs ?? 0)
    }
}

extension CommandHandler {
    func respond<R: FailureResponse>(
        requestId: String?,
        startTime: Date,
        _ body: () async throws -> R
    )
        async -> R
    {
        do {
            return try await body()
        } catch {
            return R.failure(
                requestId: requestId,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }
}
