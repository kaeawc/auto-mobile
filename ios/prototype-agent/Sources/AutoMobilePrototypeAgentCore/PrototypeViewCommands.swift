import Foundation

enum PrototypeViewCommand { case hideKeyboard }

@MainActor
protocol PrototypeEditingWindow: AnyObject {
    @discardableResult
    func endEditing(_ force: Bool) -> Bool
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
