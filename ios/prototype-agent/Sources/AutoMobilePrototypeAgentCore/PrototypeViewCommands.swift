import Foundation

enum PrototypeViewCommand { case hideKeyboard }

@MainActor
protocol PrototypeEditingWindow: AnyObject {
    @discardableResult
    func endEditing(_ force: Bool) -> Bool
}

/// Holds view commands until a window is attached: an embedded spec's initial `onAppear` runs before
/// the content controller lays out and assigns its window, so a drain with no window must not drop them.
@MainActor
struct PrototypeViewCommandQueue {
    private var pending: [PrototypeViewCommand] = []

    var isEmpty: Bool { pending.isEmpty }

    mutating func run(_ commands: [PrototypeViewCommand], in window: (any PrototypeEditingWindow)?) {
        pending.append(contentsOf: commands)
        guard let window else { return }
        let ready = pending
        pending = []
        PrototypeViewCommands.perform(ready, in: window)
    }

    mutating func clear() { pending = [] }
}

@MainActor
enum PrototypeViewCommands {
    static func perform(_ commands: [PrototypeViewCommand], in window: (any PrototypeEditingWindow)?) {
        for command in commands {
            switch command {
            case .hideKeyboard: window?.endEditing(true)
            }
        }
    }
}
