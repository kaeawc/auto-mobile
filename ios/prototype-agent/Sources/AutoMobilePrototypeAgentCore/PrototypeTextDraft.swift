import Foundation

/// Holds typed text apart from stored state until editing ends, so constrained values can be
/// typed through refused intermediates (#12206).
struct PrototypeTextDraft: Equatable, Sendable {
    private(set) var text: String

    init(stored: String) {
        text = stored
    }

    /// The field reported new text (the user's own typing).
    mutating func type(_ typed: String) {
        text = typed
    }

    /// Whether the draft differs from the stored value and needs an edit.
    func needsCommit(stored: String) -> Bool {
        text != stored
    }

    /// Editing ended: drop refused text and report whether the field was rewritten.
    @discardableResult
    mutating func endEditing(stored: String) -> Bool {
        storedChanged(to: stored)
    }

    /// Stored state changed: show it immediately, focused or not, and report a rewrite.
    @discardableResult
    mutating func storedChanged(to stored: String) -> Bool {
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
