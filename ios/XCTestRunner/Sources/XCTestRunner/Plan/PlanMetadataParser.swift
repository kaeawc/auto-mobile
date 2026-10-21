import Yams

/// Reads only the plan's top-level metadata from Yams' ordered representation tree.
enum PlanMetadataParser {
    static func parse(from yamlContent: String) throws -> PlanMetadata {
        let placeholders = PlanYamlPlaceholders(yamlContent)
        let root: Node?
        do {
            root = try Yams.compose(yaml: placeholders.yaml)
        } catch {
            throw AutoMobilePlanExecutor.ExecutorError.invalidPlan("Invalid YAML: \(error)")
        }
        var platform: AutoMobilePlanExecutor.PlanPlatform?
        if let value = root?["platform"]?.scalar?.string, !value.isEmpty {
            platform = try parsePlatform(placeholders.restore(value))
        }
        let hasDevices = root?["devices"] != nil
        var devicePlatforms: [String: AutoMobilePlanExecutor.PlanPlatform] = [:]
        var deviceLabels: [String] = []
        for entry in root?["devices"]?.sequence ?? Node.Sequence() {
            let (label, devicePlatform) = try device(from: entry, placeholders: placeholders)
            if let label { deviceLabels.append(label) }
            if let label, let devicePlatform {
                devicePlatforms[label] = devicePlatform
            } else if label != nil || devicePlatform != nil {
                throw AutoMobilePlanExecutor.ExecutorError.invalidPlan(
                    "Each device entry must include label and platform."
                )
            }
        }
        if hasDevices && deviceLabels.isEmpty {
            throw AutoMobilePlanExecutor.ExecutorError.invalidPlan(
                "Multi-device plans must declare at least one device."
            )
        }
        if hasDevices && devicePlatforms.count != deviceLabels.count {
            throw AutoMobilePlanExecutor.ExecutorError.invalidPlan(
                "Multi-device plans must declare platform for each device."
            )
        }
        return PlanMetadata(
            platform: platform, devicePlatforms: devicePlatforms,
            deviceLabels: deviceLabels, hasDevices: hasDevices
        )
    }

    /// Parse the RAW plan so supplied parameter values cannot alter the secret declaration.
    static func parseSecretParameterKeys(from yamlContent: String) throws -> Set<String> {
        let placeholders = PlanYamlPlaceholders(yamlContent)
        let root: Node?
        do {
            root = try Yams.compose(yaml: placeholders.yaml)
        } catch {
            throw AutoMobilePlanExecutor.ExecutorError.invalidPlan("Invalid YAML: \(error)")
        }
        guard let declaration = root?["secretParameters"] else {
            return []
        }
        let entries = declaration.sequence.map(Array.init) ?? [declaration]
        return try Set(entries.map { node in
            guard let value = node.scalar?.string, !value.isEmpty else {
                throw AutoMobilePlanExecutor.ExecutorError.invalidPlan(
                    "secretParameters must be a string or a list of non-empty strings"
                )
            }
            return placeholders.restore(value)
        })
    }

    private static func device(
        from entry: Node, placeholders: PlanYamlPlaceholders
    )
        throws -> (String?, AutoMobilePlanExecutor.PlanPlatform?)
    {
        guard let mapping = entry.mapping else {
            return (entry.scalar.map { placeholders.restore($0.string) }, nil)
        }
        var label: String?
        var platform: AutoMobilePlanExecutor.PlanPlatform?
        for (key, value) in mapping {
            switch key.scalar?.string {
            case "label", "name":
                label = value.scalar.map { placeholders.restore($0.string) }
            case "platform":
                if let value = value.scalar?.string {
                    platform = try parsePlatform(placeholders.restore(value))
                }
            default:
                break
            }
        }
        return (label, platform)
    }

    private static func parsePlatform(_ value: String) throws -> AutoMobilePlanExecutor.PlanPlatform {
        guard let platform = AutoMobilePlanExecutor.PlanPlatform(rawValue: value) else {
            throw AutoMobilePlanExecutor.ExecutorError.invalidPlan("Unknown platform value: \(value)")
        }
        return platform
    }
}
