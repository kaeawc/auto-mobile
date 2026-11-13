#if canImport(CarPlay)
    import CarPlay

    @MainActor
    struct CarPlayTemplateMapper {
        var maxItems = 50
        var maxNodes = 500
        var maxDepth = 6
        private(set) var actionTargets: [String: CarPlayActionTarget] = [:]
        private var selectTab: @MainActor (CPTabBarTemplate, Int) -> Void
        private var count = 0
        private var truncated = false

        init(
            maxItems: Int = 50, maxNodes: Int = 500, maxDepth: Int = 6,
            selectTab: @escaping @MainActor (CPTabBarTemplate, Int) -> Void = { $0.selectTemplate(at: $1) }
        ) {
            self.selectTab = selectTab
            self.maxItems = max(0, maxItems)
            self.maxNodes = max(0, maxNodes)
            self.maxDepth = max(0, maxDepth)
        }

        mutating func document(templates: [CPTemplate], presented: CPTemplate? = nil) -> CarPlayTemplateDocument {
            count = 0
            actionTargets = [:]
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
            actionTargets[id] = CarPlayActionTarget()
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
                        actionTargets[row.id] = CarPlayActionTarget(enabled: item.isEnabled)
                        if let selectable = item as? any CPSelectableListItem {
                            actionTargets[row.id] = CarPlayActionTarget(enabled: item.isEnabled) {
                                guard let handler = selectable.handler else {
                                    return CarPlayActionOutcome(
                                        status: .failed,
                                        reason: "The list item has no handler."
                                    )
                                }
                                handler(selectable) {}
                                return CarPlayActionOutcome(status: .success)
                            }
                        }
                        if let item = item as? CPListItem {
                            row.detailText = item.detailText
                            row.hasImage = item.image != nil
                        } else if let item = item as? CPListImageRowItem {
                            let elementCount: Int
                            if #available(iOS 26.0, *), !item.elements.isEmpty { elementCount = item.elements.count }
                            else { elementCount = item.gridImages.count }
                            row.hasImage = elementCount > 0
                            row.buttons = limited(Array(0 ..< elementCount)).compactMap { index in
                                guard let element = allocate(
                                    "\(row.id)/buttons/\(index)",
                                    "imageRowElement",
                                    depth: depth + 3
                                )
                                else { return nil }
                                element.enabled = item.isEnabled
                                element.hasImage = true
                                actionTargets[element.id] = CarPlayActionTarget(enabled: item.isEnabled) {
                                    guard let handler = item.listImageRowHandler else {
                                        return CarPlayActionOutcome(
                                            status: .failed,
                                            reason: "The image row has no element handler."
                                        )
                                    }
                                    handler(item, index) {}
                                    return CarPlayActionOutcome(status: .success)
                                }
                                return element
                            }
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
                    actionTargets[value.id] = CarPlayActionTarget(enabled: button.isEnabled)
                    return value
                }
            case let tabs as CPTabBarTemplate:
                result.type = "tabBar"
                result.tabs = limited(tabs.templates).enumerated().compactMap { k, child in
                    guard let value = allocate("\(id)/tabs/\(k)", "tab", depth: depth + 1) else { return nil }
                    value.title = child.tabTitle
                    value.selected = child === tabs.selectedTemplate
                    let select = selectTab
                    actionTargets[value.id] = CarPlayActionTarget {
                        select(tabs, k)
                        return CarPlayActionOutcome(status: .success)
                    }
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
                result.actions = textButtons(info.actions, id: id, depth: depth)
            case let alert as CPAlertTemplate:
                result.type = "alert"
                result.titleVariants = alert.titleVariants
                result.actions = alertActions(alert.actions, id: id, depth: depth)
            case let sheet as CPActionSheetTemplate:
                result.type = "actionSheet"
                result.title = sheet.title
                result.message = sheet.message
                result.actions = alertActions(sheet.actions, id: id, depth: depth)
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
            if let source = barButtonSource(for: template) {
                result.leadingNavigationBarButtons = barButtons(
                    source.leading,
                    id: "\(id)/leadingNavigationBarButtons",
                    depth: depth
                )
                result.trailingNavigationBarButtons = barButtons(
                    source.trailing,
                    id: "\(id)/trailingNavigationBarButtons",
                    depth: depth
                )
                if let button = source.back {
                    result.backButton = barButtons([button], id: "\(id)/backButton", depth: depth).first
                }
            }
            return result
        }

        private func barButtonSource(for template: CPTemplate)
            -> (leading: [CPBarButton], trailing: [CPBarButton], back: CPBarButton?)?
        {
            // CPTemplate stubs can answer responds(to:) and still raise. Use only declared concrete APIs.
            switch template {
            case let list as CPListTemplate:
                return (list.leadingNavigationBarButtons, list.trailingNavigationBarButtons, list.backButton)
            case let grid as CPGridTemplate:
                return (grid.leadingNavigationBarButtons, grid.trailingNavigationBarButtons, grid.backButton)
            case let info as CPInformationTemplate:
                return (info.leadingNavigationBarButtons, info.trailingNavigationBarButtons, info.backButton)
            case let poi as CPPointOfInterestTemplate:
                return (poi.leadingNavigationBarButtons, poi.trailingNavigationBarButtons, poi.backButton)
            case let map as CPMapTemplate:
                return (map.leadingNavigationBarButtons, map.trailingNavigationBarButtons, map.backButton)
            case let contact as CPContactTemplate:
                return (contact.leadingNavigationBarButtons, contact.trailingNavigationBarButtons, contact.backButton)
            case let voice as CPVoiceControlTemplate:
                if #available(iOS 26.4, *) {
                    return (voice.leadingNavigationBarButtons, voice.trailingNavigationBarButtons, voice.backButton)
                }
                return nil
            default:
                return nil
            }
        }

        private mutating func alertActions(
            _ actions: [CPAlertAction],
            id: String,
            depth: Int
        )
            -> [CarPlayTemplateNode]
        {
            limited(actions).enumerated().compactMap { index, action in
                guard let value = allocate("\(id)/actions/\(index)", "action", depth: depth + 1) else { return nil }
                value.title = action.title
                actionTargets[value.id] = CarPlayActionTarget {
                    action.handler(action)
                    return CarPlayActionOutcome(status: .success)
                }
                return value
            }
        }

        private mutating func textButtons(_ buttons: [CPTextButton], id: String, depth: Int) -> [CarPlayTemplateNode] {
            limited(buttons).enumerated().compactMap { index, button in
                guard let value = allocate("\(id)/actions/\(index)", "textButton", depth: depth + 1) else { return nil }
                value.title = button.title
                return value
            }
        }

        private mutating func barButtons(_ buttons: [CPBarButton], id: String, depth: Int) -> [CarPlayTemplateNode] {
            limited(buttons).enumerated().compactMap { index, button in
                guard let value = allocate("\(id)/\(index)", "barButton", depth: depth + 1) else { return nil }
                value.title = button.title
                value.enabled = button.isEnabled
                value.hasImage = button.image != nil
                actionTargets[value.id] = CarPlayActionTarget(enabled: button.isEnabled)
                return value
            }
        }
    }
#endif
