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
    /// Baseline only for non-destructive horizontal arrows. Age and text checks
    /// cannot detect external caret movement: a memo only confirms an exact
    /// one-step move and is never the basis for a retry or a no-effect/direction
    /// verdict. Any mismatch is unverified. Forward delete always probes its
    /// BEFORE caret independently.
    struct CaretMemo: Sendable {
        let bundleId: String
        let value: String
        let index: Int
        private let age: @Sendable () -> Duration

        nonisolated init<C: Clock>(bundleId: String, value: String, index: Int, clock: C)
            where C.Duration == Duration
        {
            self.bundleId = bundleId
            self.value = value
            self.index = index
            let recordedAt = clock.now
            age = { recordedAt.duration(to: clock.now) }
        }

        nonisolated func caret(bundleId: String?, value: String?) -> Int? {
            let elapsed = age()
            guard bundleId == self.bundleId, value == self.value,
                  elapsed >= .zero, elapsed < GesturePerformer.caretMemoTTL,
                  index >= 0, index <= self.value.count
            else { return nil }
            return index
        }
    }

    public func invalidateCaretMemo() { caretMemo = nil }

    /// Clear before every key's validation/delivery; only plain horizontal arrows reuse the memo.
    func consumeCaretMemo(key: String, modifiers: [String]) -> CaretMemo? {
        let memo = caretMemo
        caretMemo = nil
        guard modifiers.isEmpty, ["arrow_left", "arrow_right"].contains(key.lowercased()) else { return nil }
        return memo
    }

    func rememberCaret(bundleId: String?, value: String, index: Int) {
        guard let bundleId, !bundleId.isEmpty else { return }
        caretMemo = CaretMemo(bundleId: bundleId, value: value, index: index, clock: keyboardClock)
    }
}
