import Foundation

/// Unknown cancellation ids remain valid no-ops; only the host emits an advisory.
enum PrototypeTimerValidator {
    static func validate(_ actions: [PrototypeLocatedValue]) throws {
        var ids = Set<String>()
        for action in actions {
            let fields = action.value
            guard let type = fields["type"]?.stringValue,
                  type == "startTimer" || type == "cancelTimer" else { continue }
            if fields["id"]?.stringValue?.isEmpty == true {
                throw PrototypeContractValidator.invalid("\(action.path).id", "Timer id must not be empty")
            }
            guard type == "startTimer" else { continue }
            if fields["maxRuns"] != nil, fields["everyMs"] == nil {
                throw PrototypeContractValidator.invalid("\(action.path).maxRuns", "maxRuns requires everyMs")
            }
            if let id = fields["id"]?.stringValue { ids.insert(id) }
            if ids.count > 8 {
                throw PrototypeContractValidator.invalid("\(action.path).id", "Too many distinct timer ids")
            }
        }
    }
}
