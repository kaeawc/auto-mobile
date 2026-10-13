import Foundation

/// Holds displayed text apart from stored state so refused input becomes a real value change
/// (typed text -> stored text) that the platform field can redraw without losing focus.
struct PrototypeTextDraft: Equatable, Sendable {
    private(set) var text: String

    init(stored: String) {
        text = stored
    }

    /// The field reported new text.
    mutating func type(_ typed: String) {
        text = typed
    }

    /// Whether the draft differs from the stored value and needs an edit.
    func needsCommit(stored: String) -> Bool {
        text != stored
    }

    /// Shows the stored value after an edit or an external change; reports a rewrite.
    @discardableResult
    mutating func settle(stored: String) -> Bool {
        guard text != stored else { return false }
        text = stored
        return true
    }
}

/// Refused edits (#11562) and no-ops leave platform controls needing their stored values redrawn.
enum PrototypeRefusedChange {
    static func leftValuesUnchanged(before: PrototypeSession, after: PrototypeSession) -> Bool {
        before.state == after.state && before.pages == after.pages
    }
}
