#if canImport(CtrlProxyRewrite)
    @testable import CtrlProxyRewrite
#endif
import Foundation

enum CaretMovePressVerdict: Equatable, Sendable {
    case verified
    case unverifiedAfterSend
    case failure(reason: String)
}

func classifyCaretMovePress(_ result: Result<Bool?, any Error>) -> CaretMovePressVerdict {
    switch result {
    case .success(true):
        return .verified
    case .success(false):
        return .unverifiedAfterSend
    case .success(nil):
        return .failure(reason: "Unexpected nil verification for a plain arrow")
    case let .failure(error):
        return .failure(reason: error.localizedDescription)
    }
}
