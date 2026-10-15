import Foundation
import ObjCExceptionCatcher
import os
#if os(iOS)
    import UIKit
#endif
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

extension GesturePerformer {
    enum ClipboardReadResult: Equatable {
        case value(String)
        case empty
        case unavailable
    }

    nonisolated static func resolveClipboardGet(readResult: ClipboardReadResult) throws -> String? {
        switch readResult {
        case let .value(text):
            return text.isEmpty ? nil : text
        case .empty:
            return nil
        case .unavailable:
            throw GestureError.clipboardReadUnavailable
        }
    }

    /// Cmd+V does not need the text, so only a pasteboard known to be empty refuses the paste.
    /// `.unavailable` is only produced after `hasStrings` was true, so it must still paste; the
    /// host's post-paste check decides whether the field changed (#10083).
    nonisolated static func resolveClipboardPaste(readResult: ClipboardReadResult) throws {
        switch readResult {
        case let .value(text):
            if text.isEmpty { throw GestureError.clipboardEmpty }
        case .empty:
            throw GestureError.clipboardEmpty
        case .unavailable:
            return
        }
    }
}
