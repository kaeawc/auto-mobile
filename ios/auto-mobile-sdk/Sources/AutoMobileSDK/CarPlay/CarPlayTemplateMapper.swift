#if canImport(CarPlay)
    import CarPlay

    @MainActor
    struct CarPlayTemplateMapper {
        var maxItems = 50
        var maxNodes = 500
        var maxDepth = 6
        private var count = 0
        private var truncated = false

        init(maxItems: Int = 50, maxNodes: Int = 500, maxDepth: Int = 6) {
            self.maxItems = max(0, maxItems)
            self.maxNodes = max(0, maxNodes)
            self.maxDepth = max(0, maxDepth)
        }

        mutating func document(templates: [CPTemplate], presented: CPTemplate? = nil) -> CarPlayTemplateDocument {
            count = 0
            truncated = false
            let stack = limited(templates).enumerated()
                .compactMap { node($0.element, id: "stack/\($0.offset)", depth: 0) }
            let modal = presented.flatMap { node($0, id: "presented", depth: 0) }
            return CarPlayTemplateDocument(
                enabled: true,
                connected: true,
                templates: stack,
                presented: modal,
                truncated: truncated
            )
        }

        private mutating func allocate(_ id: String, _ type: String, depth: Int) -> CarPlayTemplateNode? {
            guard count < maxNodes, depth <= maxDepth else {
                truncated = true
                return nil
            }
            count += 1
            return CarPlayTemplateNode(id: id, type: type)
        }

        private mutating func limited<T>(_ values: [T]) -> ArraySlice<T> {
            if values.count > maxItems { truncated = true }
            return values.prefix(maxItems)
        }

        mutating func node(_ template: CPTemplate, id: String, depth: Int) -> CarPlayTemplateNode? {
            guard let result = allocate(id, "unknown", depth: depth) else { return nil }
            switch template {
            case let list as CPListTemplate:
                result.type = "list"
                result.title = list.title
                result.sections = limited(list.sections).enumerated().compactMap { sectionIndex, section in
                    guard let value = allocate("\(id)/sections/\(sectionIndex)", "section", depth: depth + 1)
                    else { return nil }
                    value.header = section.header
                    value.items = limited(section.items).enumerated().compactMap { k, item in
                        guard let row = allocate("\(value.id)/items/\(k)", "item", depth: depth + 2) else { return nil }
                        row.text = item.text
                        row.enabled = item.isEnabled
                        row.hasImage = false
                        if let item = item as? CPListItem {
                            row.detailText = item.detailText
                            row.hasImage = item.image != nil
                        } else if let item = item as? CPListImageRowItem {
                            row.hasImage = !item.gridImages.isEmpty
                        }
                        return row
                    }
                    return value
                }
            case let grid as CPGridTemplate:
                result.type = "grid"
                result.title = grid.title
                result.buttons = limited(grid.gridButtons).enumerated().compactMap { k, button in
                    guard let value = allocate("\(id)/buttons/\(k)", "button", depth: depth + 1) else { return nil }
                    value.titleVariants = button.titleVariants
                    value.enabled = button.isEnabled
                    return value
                }
            case let tabs as CPTabBarTemplate:
                result.type = "tabBar"
                result.tabs = limited(tabs.templates).enumerated().compactMap { k, child in
                    guard let value = allocate("\(id)/tabs/\(k)", "tab", depth: depth + 1) else { return nil }
                    value.title = child.tabTitle
                    value.selected = child === tabs.selectedTemplate
                    value.template = node(child, id: "\(value.id)/template", depth: depth + 2)
                    return value
                }
            case let info as CPInformationTemplate:
                result.type = "information"
                result.title = info.title
                result.items = limited(info.items).enumerated().compactMap { k, item in
                    guard let value = allocate("\(id)/items/\(k)", "item", depth: depth + 1) else { return nil }
                    value.title = item.title
                    value.detail = item.detail
                    return value
                }
            case let alert as CPAlertTemplate:
                result.type = "alert"
                result.titleVariants = alert.titleVariants
            case let sheet as CPActionSheetTemplate:
                result.type = "actionSheet"
                result.title = sheet.title
                result.message = sheet.message
                result.actions = limited(sheet.actions).enumerated().compactMap { k, action in
                    guard let value = allocate("\(id)/actions/\(k)", "action", depth: depth + 1) else { return nil }
                    value.title = action.title
                    return value
                }
            case let poi as CPPointOfInterestTemplate:
                result.type = "pointOfInterest"
                result.title = poi.title
            case is CPNowPlayingTemplate: result.type = "nowPlaying"
            case is CPVoiceControlTemplate: result.type = "voiceControl"
            case is CPContactTemplate: result.type = "contact"
            case is CPMapTemplate: result.type = "map"
            case is CPSearchTemplate: result.type = "search"
            default: result.className = String(describing: type(of: template))
            }
            return result
        }
    }
#endif
