import Foundation

struct CarPlayActionRequest: Decodable, Sendable {
    enum Action: String, Codable, Sendable {
        case select, back, popToRoot
    }

    var id: String?
    var action: Action = .select

    init(id: String? = nil, action: Action = .select) {
        self.id = id
        self.action = action
    }

    private enum CodingKeys: String, CodingKey { case id, action }

    init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = values.contains(.id) ? try values.decode(String.self, forKey: .id) : nil
        action = values.contains(.action) ? try values.decode(Action.self, forKey: .action) : .select
    }

    var isValid: Bool {
        action != .select || !(id?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }
}

struct CarPlayActionOutcome: Sendable {
    enum Status: String, Encodable, Sendable {
        case success = "ok", unsupported, notFound = "not_found", failed
    }

    var status: Status
    var reason: String?
}

struct CarPlayActionResponse: Encodable {
    let schemaVersion = 1
    let simulated = "sdk"
    var status: CarPlayActionOutcome.Status
    var reason: String?
    var id: String?
    var action: CarPlayActionRequest.Action
    var templates: CarPlayTemplateDocument
}

@MainActor
protocol CarPlayActionSource: CarPlayTemplateSource {
    func carPlaySelect(id: String) -> CarPlayActionOutcome
    func carPlayPop(toRoot: Bool, completion: @escaping @MainActor (CarPlayActionOutcome) -> Void)
}

#if canImport(CarPlay)
    import CarPlay

    @MainActor
    struct CarPlayActionTarget {
        var enabled = true
        var perform: @MainActor () -> CarPlayActionOutcome = {
            CarPlayActionOutcome(status: .unsupported, reason: "This element has no public CarPlay selection API.")
        }
    }

    @MainActor
    struct CarPlayActionPerformer {
        var selectTab: @MainActor (CPTabBarTemplate, Int) -> Void = { tabs, index in
            tabs.selectTemplate(at: index)
        }

        func select(id: String, templates: [CPTemplate], presented: CPTemplate?) -> CarPlayActionOutcome {
            var mapper = CarPlayTemplateMapper(selectTab: selectTab)
            // Resolve only nodes emitted by this same bounded snapshot walk, including presented templates.
            _ = mapper.document(templates: templates, presented: presented)
            guard let target = mapper.actionTargets[id] else {
                return CarPlayActionOutcome(
                    status: .notFound,
                    reason: "No element has this id in the current snapshot."
                )
            }
            guard target.enabled else {
                return CarPlayActionOutcome(status: .failed, reason: "The CarPlay element is disabled.")
            }
            return target.perform()
        }
    }
#endif
