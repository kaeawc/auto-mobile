import Foundation

/// Reject-only validation of an authored spec. No renderer, I/O, storage or networking is started.
public enum PrototypeSpecStrictValidator {
    /// Accepts by returning normally; rejects with `PrototypeLoadError.invalidSpec(path:message:)`.
    public static func validate(data: Data, supportedCapabilities: Set<String>? = nil, library: Bool = false) throws {
        do {
            let data = try PrototypeStrictJSON.prepare(data)
            let (value, context) = try PrototypeContractValidator.inspect(data: data)
            guard let fields = value.objectFields,
                  let root = fields["root"]
            else { throw PrototypeContractValidator.invalid("$", "Expected prototype envelope") }
            let state = fields["state"]?.objectFields ?? [:]
            let modelData = fields["data"]?.objectFields
            try PrototypeStrictSemantics.layout(context)
            var repeats = PrototypeStrictRepeats(data: modelData)
            try repeats.templates(root.objectFields ?? [:], path: "root")
            try PrototypeLimits.guardRepeatPathCells(root, data: modelData)
            try PrototypeLimits.guardSubstitutedText(root, data: modelData)
            try repeats.expanded(root.objectFields ?? [:], path: "root")
            try PrototypeStrictSemantics.storage(fields)
            try PrototypeDataWrite.validate(actions: context.actions, data: modelData)
            try PrototypeStrictSemantics.vocabulary(context, data: modelData)
            try PrototypeLinkify.validate(root: root, nodes: context.locatedNodes)
            try PrototypeStrictSemantics.targets(context)
            let nodes = repeats.bound(context.locatedNodes)
            let actions = repeats.bound(context.actions, actions: true)
            try PrototypeStrictBindings.validate(nodes: nodes, actions: actions, state: state)
            try PrototypeChecks.validate(nodes: nodes, actions: actions, state: state)
            try PrototypePlatformValidator.validate(
                requires: fields["requires"],
                handlers: fields["platform"],
                root: root,
                state: state
            )
            try PrototypeLimits.guardAuthoredTree(root)
            try PrototypeRequestValidator.validate(root, state: state)
            try PrototypeMenus.validateAuthoredText(root)
            try PrototypeRepeat.validateEmitContexts(root, data: modelData)
            let resolved = PrototypeDataResolver.resolveRoot(root, data: modelData)
            try PrototypeLimits.guardTree(resolved)
            let expanded = PrototypeRepeat.expand(resolved)
            try PrototypePagerOptions.validate(expanded)
            try PrototypeSwipe.validate(expanded)
            try PrototypeCarousel.validate(expanded)
            try PrototypeRefresh.validate(expanded)
            try PrototypeMenus.validate(expanded, state: state)
            if let supportedCapabilities,
               !PrototypeStrictCapabilities.required(fields).isSubset(of: supportedCapabilities)
            {
                throw PrototypeContractValidator.invalid("$", "Unsupported capabilities")
            }
            if library, let window = fields["window"]?.objectFields {
                if window["layer"] ==
                    .string("system") { throw PrototypeContractValidator.invalid("window.layer", "Privileged window") }
                if window["persistence"] ==
                    .string("device")
                {
                    throw PrototypeContractValidator.invalid("window.persistence", "Privileged window")
                }
            }
            // Located actions exclude opaque data, request bodies and emit payloads.
            if library, let host = context.actions.first(where: {
                $0.value["type"] == .string("request") && $0.value["via"] == .string("host")
            }) {
                throw PrototypeContractValidator.invalid(
                    "\(host.path).via",
                    "Host requests are unavailable in a library"
                )
            }
        } catch let error as PrototypeLoadError { throw error }
        catch let DecodingError.dataCorrupted(context) {
            if let separator = context.debugDescription.range(of: ": ") {
                throw PrototypeLoadError.invalidSpec(
                    path: String(context.debugDescription[..<separator.lowerBound]),
                    message: String(context.debugDescription[separator.upperBound...])
                )
            }
            throw PrototypeContractValidator.invalid("$", context.debugDescription)
        } catch { throw PrototypeContractValidator.invalid("$", error.localizedDescription) }
    }
}
