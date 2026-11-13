import Foundation

/// Value-only snapshot; no CarPlay dependency or image payloads.
struct CarPlayTemplateDocument: Codable {
    var schemaVersion = 1
    var enabled = false
    var connected = false
    var templates: [CarPlayTemplateNode] = []
    var presented: CarPlayTemplateNode?
    var truncated = false
    var error: String?
}

final class CarPlayTemplateNode: Codable {
    var id: String
    var type: String
    var className: String?
    var title: String?
    var text: String?
    var detailText: String?
    var detail: String?
    var header: String?
    var message: String?
    var enabled: Bool?
    var hasImage: Bool?
    var selected: Bool?
    var titleVariants: [String]?
    var sections: [CarPlayTemplateNode]?
    var items: [CarPlayTemplateNode]?
    var buttons: [CarPlayTemplateNode]?
    var tabs: [CarPlayTemplateNode]?
    var template: CarPlayTemplateNode?
    var actions: [CarPlayTemplateNode]?
    var leadingNavigationBarButtons: [CarPlayTemplateNode]?
    var trailingNavigationBarButtons: [CarPlayTemplateNode]?
    var backButton: CarPlayTemplateNode?

    init(id: String, type: String) {
        self.id = id
        self.type = type
    }
}
