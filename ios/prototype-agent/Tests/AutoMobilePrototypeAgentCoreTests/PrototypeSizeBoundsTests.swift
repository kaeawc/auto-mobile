@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeSizeBoundsTests: XCTestCase {
    private var repository: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    func testConstantsMatchTheSharedContract() throws {
        let contract = try JSONSerialization.jsonObject(
            with: Data(contentsOf: repository.appendingPathComponent("schemas/prototype-spec-contract.json"))
        ) as? [String: Any]
        let definitions = try XCTUnwrap(contract?["definitions"] as? [String: [String: Any]])
        for (group, ranges) in PrototypeSizeBounds.ranges {
            var definition = try XCTUnwrap(definitions[group == "sheet" ? "placement" : group])
            if group == "sheet" {
                let variants = try XCTUnwrap(definition["variants"] as? [String: [String: Any]])
                definition = try XCTUnwrap(variants["sheet"])
            } else if ["dimension", "detent", "cornerRadius"].contains(group) {
                let options = try XCTUnwrap(definition["options"] as? [[String: Any]])
                definition = options[group == "cornerRadius" ? 2 : 1]
            }
            let fields = try XCTUnwrap(definition["fields"] as? [String: [String: Any]])
            for (field, range) in ranges {
                let rule: [String: Any]
                if group == "style", field == "cornerRadius" {
                    let options = try XCTUnwrap(definitions["cornerRadius"]?["options"] as? [[String: Any]])
                    rule = options[0]
                } else {
                    rule = try XCTUnwrap(fields[field]?["rule"] as? [String: Any])
                }
                XCTAssertEqual(range.lowerBound, rule["min"] as? Double, "\(group).\(field).min")
                XCTAssertEqual(range.upperBound, rule["max"] as? Double, "\(group).\(field).max")
            }
        }
    }

    func testSharedSizeFixturesRejectWithIdenticalPathAndMessage() throws {
        let directory = repository.appendingPathComponent("test/fixtures/prototype-spec/invalid")
        let minimumFixtures = [
            "negative-elevation.json", "negative-max-width.json", "zero-weight.json",
            "zero-aspect-ratio.json", "zero-line-height.json", "corner-radius-negative-corner.json",
        ]
        for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .sorted(by: { $0.lastPathComponent < $1.lastPathComponent })
            where file.lastPathComponent.hasSuffix("-over-max.json") ||
            file.lastPathComponent.hasSuffix("-below-min.json") ||
            file.lastPathComponent.hasSuffix("-first-error.json") || minimumFixtures.contains(file.lastPathComponent)
        {
            let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
            let spec = try JSONSerialization.data(withJSONObject: XCTUnwrap(fixture["spec"]))
            let path = try XCTUnwrap(fixture["expectedPath"] as? String)
            let message = fixture["expectedMessage"] as? String ?? "Invalid number value"
            XCTAssertThrowsError(
                try JSONDecoder().decode(PrototypeSpec.self, from: spec),
                file.lastPathComponent
            ) { error in
                if file.lastPathComponent.hasSuffix("-first-error.json") {
                    let actualPath: String
                    switch error {
                    case let DecodingError.dataCorrupted(context):
                        actualPath = context.debugDescription.components(separatedBy: ": ")[0]
                    case let DecodingError.typeMismatch(_, context),
                         let DecodingError.keyNotFound(_, context),
                         let DecodingError.valueNotFound(_, context):
                        actualPath = context.codingPath.reduce(into: "") { path, key in
                            if let index = key.intValue {
                                path += "[\(index)]"
                            } else {
                                if !path.isEmpty { path += "." }
                                path += key.stringValue
                            }
                        }
                    default:
                        return XCTFail("\(file.lastPathComponent): \(error)")
                    }
                    XCTAssertEqual(actualPath, path, file.lastPathComponent)
                    return
                }
                guard case let DecodingError.dataCorrupted(context) = error else {
                    return XCTFail("\(file.lastPathComponent): \(error)")
                }
                XCTAssertEqual(context.debugDescription, "\(path): \(message)", file.lastPathComponent)
            }
        }
    }

    func testSharedBoundaryAndExistingValidFixturesDecode() throws {
        let directory = repository.appendingPathComponent("test/fixtures/prototype-spec/valid")
        // The size guard can check every host fixture even where the agent's supported feature
        // subset differs. Decode the boundary through the full agent entry point as well.
        for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            where file.pathExtension == "json"
        {
            let data = try Data(contentsOf: file)
            try PrototypeSizeBounds.validate(JSONDecoder().decode(JSONValue.self, from: data))
            if file.lastPathComponent == "width-dp-at-max.json" {
                _ = try JSONDecoder().decode(PrototypeSpec.self, from: data)
            }
        }
    }
}
