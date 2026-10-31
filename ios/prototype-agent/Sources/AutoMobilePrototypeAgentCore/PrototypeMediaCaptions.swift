import Foundation

/// Rules for `videoPlayer.captions` (#14259) that the contract cannot express, the twin of the host's
/// `prototypeMediaCaptions.ts`: track ids are unique per player and never use the `hls:` prefix
/// in-band tracks own, and `/data` cues point at a declared array of `mediaCaptionCue` objects that
/// each end after they start.
enum PrototypeMediaCaptions {
    private static let cueRule: JSONValue = .object(["kind": .string("ref"), "name": .string("mediaCaptionCue")])

    /// Throws at the first caption rule a spec's `videoPlayer` nodes break.
    static func validate(_ spec: [String: JSONValue], nodes: [PrototypeLocatedValue]) throws {
        let data = spec["data"]?.objectFields
        for node in nodes where node.value["type"] == .string("videoPlayer") {
            guard case let .array(captions)? = node.value["captions"] else { continue }
            try validatePlayer(captions, data: data, path: "\(node.path).captions")
        }
    }

    private static func validatePlayer(_ captions: [JSONValue], data: [String: JSONValue]?, path: String) throws {
        // Exact UTF-16 code units, as the host and Kotlin compare; a String set merges canonically
        // equivalent ids.
        var seen: Set<[UInt16]> = []
        for (index, raw) in captions.enumerated() {
            guard let caption = raw.objectFields else { continue }
            let at = "\(path)[\(index)]"
            let id = caption["id"]?.stringValue ?? ""
            if id.hasPrefix("hls:") {
                throw PrototypeLimits.violation("\(at).id", "Caption ids starting with hls: are reserved")
            }
            if !seen.insert(Array(id.utf16)).inserted {
                throw PrototypeLimits.violation("\(at).id", "Duplicate caption id")
            }
            if let source = caption["source"]?.objectFields, let pointer = source["data"] {
                try validateCues(pointer.stringValue, data: data, path: "\(at).source.data")
            }
        }
    }

    private static func validateCues(_ pointer: String?, data: [String: JSONValue]?, path: String) throws {
        guard let pointer, let dataPointer = PrototypeDataWrite.pointer(ofPath: pointer),
              case let .array(cues)? = PrototypeDataPointer.resolve(data, pointer: dataPointer)
        else { throw PrototypeLimits.violation(path, "Caption data must point to a /data array") }
        let base = PrototypeDataPointer.tokens(dataPointer)
            .reduce(into: "data") { $0 = PrototypeContractValidator.keyPath($0, $1) }
        for (index, cue) in cues.enumerated() {
            let at = "\(base)[\(index)]"
            try PrototypeContractValidator.validateValue(cue, rule: cueRule, path: at)
            if case let .number(start)? = cue.objectFields?["startMs"],
               case let .number(end)? = cue.objectFields?["endMs"], end <= start
            {
                throw PrototypeLimits.violation("\(at).endMs", "A caption cue must end after it starts")
            }
        }
    }
}
