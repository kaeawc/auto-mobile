#if os(macOS)
    import AppKit
    import ApplicationServices
    import AXBridgeCore

    @MainActor
    final class AXBridgeExecutor {
        func execute(_ request: AXBridgeRequest) -> Result<Void, AXBridgeError> {
            if let error = AXBridgeError.preflight(isTrusted: AXIsProcessTrusted()) {
                return .failure(error)
            }
            guard let simulator = NSRunningApplication.runningApplications(
                withBundleIdentifier: "com.apple.iphonesimulator"
            ).first else {
                return .failure(AXBridgeError(code: "simulator_not_running", message: "Open Simulator, then retry."))
            }
            do throws(AXBridgeError) {
                let application = AXUIElementCreateApplication(simulator.processIdentifier)
                let windows = try elements(application, attribute: kAXWindowsAttribute)
                let nodes = try contentNodes(in: windows)
                var candidates: [AXBridgeCandidate] = []
                var identifiedNodes: [AXUIElement] = []
                for node in nodes {
                    let candidate = try AXBridgeCandidate(
                        identifier: string(node, attribute: kAXIdentifierAttribute),
                        description: string(node, attribute: kAXDescriptionAttribute),
                        rawActions: []
                    )
                    guard AXBridgeActionMatcher.identifies(candidate, for: request) else { continue }
                    try candidates.append(AXBridgeCandidate(
                        identifier: candidate.identifier,
                        description: candidate.description,
                        rawActions: actions(node)
                    ))
                    identifiedNodes.append(node)
                }
                let match = try AXBridgeActionMatcher.match(in: candidates, for: request)
                let node = identifiedNodes[match.candidateIndex]
                // Revalidate against the current AX list, but never reconstruct its opaque action string.
                guard try actions(node).contains(match.rawAction) else {
                    return .failure(AXBridgeError(
                        code: "action_not_found",
                        message: "The custom action is no longer available. Retry with a fresh element."
                    ))
                }
                try check(
                    AXUIElementPerformAction(node, match.rawAction as CFString),
                    operation: "AXUIElementPerformAction"
                )
                return .success(())
            } catch {
                return .failure(error)
            }
        }

        /// Discovery starts at windows, never the application children (which include the Simulator menu bar).
        /// Outside content groups only structural attributes are read; only group descendants become candidates.
        private func contentNodes(in windows: [AXUIElement]) throws(AXBridgeError) -> [AXUIElement] {
            var pending = windows.reversed().map { ($0, false) }
            var visited: [AXUIElement] = []
            var nodes: [AXUIElement] = []
            while let (node, insideGroup) = pending.popLast() {
                guard !visited.contains(where: { CFEqual($0, node) }) else { continue }
                visited.append(node)
                guard try string(node, attribute: kAXRoleAttribute) != kAXMenuBarRole else { continue }
                let subrole = try string(node, attribute: kAXSubroleAttribute)
                let inContent = insideGroup || subrole == AXBridgeActionMatcher.contentGroupSubrole
                if inContent { nodes.append(node) }
                let children = try elements(node, attribute: kAXChildrenAttribute)
                pending.append(contentsOf: children.reversed().map { ($0, inContent) })
            }
            return nodes
        }

        private func value(_ node: AXUIElement, attribute: String) throws(AXBridgeError) -> CFTypeRef? {
            var value: CFTypeRef?
            let status = AXUIElementCopyAttributeValue(node, attribute as CFString, &value)
            // Missing optional attributes and leaf children are expected while traversing heterogeneous AX nodes.
            if status == .attributeUnsupported || status == .noValue { return nil }
            try check(status, operation: "AXUIElementCopyAttributeValue(\(attribute))")
            return value
        }

        private func string(_ node: AXUIElement, attribute: String) throws(AXBridgeError) -> String? {
            guard let value = try value(node, attribute: attribute) else { return nil }
            guard let string = value as? String else { throw invalidValue(attribute) }
            return string
        }

        private func elements(_ node: AXUIElement, attribute: String) throws(AXBridgeError) -> [AXUIElement] {
            guard let value = try value(node, attribute: attribute) else { return [] }
            guard let elements = value as? [AXUIElement] else { throw invalidValue(attribute) }
            return elements
        }

        private func actions(_ node: AXUIElement) throws(AXBridgeError) -> [String] {
            var names: CFArray?
            try check(AXUIElementCopyActionNames(node, &names), operation: "AXUIElementCopyActionNames")
            guard let names else { return [] }
            guard let actions = names as? [String] else { throw invalidValue("action names") }
            return actions
        }

        private func check(_ status: AXError, operation: String) throws(AXBridgeError) {
            if let error = AXBridgeError.axFailure(status: status.rawValue, operation: operation) { throw error }
        }

        private func invalidValue(_ attribute: String) -> AXBridgeError {
            AXBridgeError(code: "ax_invalid_value", message: "AX returned an unexpected type for \(attribute).")
        }
    }
#endif
