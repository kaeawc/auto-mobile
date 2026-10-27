@testable import AutoMobilePrototypeAgentCore
import XCTest

/// The platform vocabulary backstop (#14294) rejects the shared fixtures at the host's paths, and
/// its module table, permission and background names match the shared contract.
final class PrototypePlatformTests: XCTestCase {
    private var contract: [String: Any] {
        get throws {
            let url = PrototypeSpecFixtures.directory
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("schemas/prototype-spec-contract.json")
            return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        }
    }

    private func fixtures(_ kind: String) throws -> [String] {
        try FileManager.default
            .contentsOfDirectory(atPath: PrototypeSpecFixtures.directory.appendingPathComponent(kind).path)
            .filter { $0.hasPrefix("platform-") && $0.hasSuffix(".json") }
            .sorted()
    }

    func testModuleTableMatchesTheSharedContract() throws {
        let table = try XCTUnwrap(contract["platformModules"] as? [String: [String: Any]])
        XCTAssertEqual(Set(table.keys), Set(PrototypePlatformValidator.modules.keys))
        for (name, entry) in table {
            let module = try XCTUnwrap(PrototypePlatformValidator.modules[name])
            XCTAssertEqual(module.capability, entry["capability"] as? String, name)
            XCTAssertEqual(module.state, (entry["state"] as? [String: Any]).map { Set($0.keys) }, name)
            let events = try XCTUnwrap(entry["events"] as? [String: Any])
            XCTAssertEqual(module.events, Set(events.keys), name)
            let calls = try XCTUnwrap(entry["calls"] as? [String: [String: Any]])
            XCTAssertEqual(Set(calls.keys), Set(module.calls.keys), name)
            for (op, call) in calls {
                let swift = try XCTUnwrap(module.calls[op])
                XCTAssertEqual(swift.permissions, call["permissions"] as? [String], op)
                XCTAssertEqual(swift.background, call["background"] as? [String], op)
                let args = try XCTUnwrap(call["args"] as? [String: [String: Any]])
                XCTAssertEqual(Set(args.keys), Set(swift.args.keys), op)
                for (arg, definition) in args {
                    let argument = try XCTUnwrap(swift.args[arg])
                    XCTAssertEqual(argument.optional, definition["optional"] as? Bool, arg)
                    let rule = try XCTUnwrap(definition["value"] as? [String: Any])
                    switch argument.rule {
                    case let .json(maxBytes):
                        XCTAssertEqual(rule["kind"] as? String, "json", arg)
                        XCTAssertEqual(
                            rule["maxBytes"] as? Int ?? PrototypeContractValidator.limit("MAX_PROTOTYPE_SPEC_BYTES"),
                            maxBytes,
                            arg
                        )
                    case let .string(max):
                        XCTAssertEqual(rule["kind"] as? String, "string", arg)
                        XCTAssertEqual(rule["max"] as? Int, max, arg)
                    case let .integer(min, max):
                        XCTAssertEqual(rule["kind"] as? String, "number", arg)
                        XCTAssertEqual(rule["integer"] as? Bool, true, arg)
                        XCTAssertEqual(rule["min"] as? Double, min, arg)
                        XCTAssertEqual(rule["max"] as? Double, max, arg)
                    case let .enumeration(values):
                        XCTAssertEqual(rule["kind"] as? String, "enum", arg)
                        XCTAssertEqual(Set(rule["values"] as? [String] ?? []), values, arg)
                    }
                }
            }
        }
    }

    func testNamesAndLimitsMatchTheSharedContract() throws {
        let definitions = try XCTUnwrap(contract["definitions"] as? [String: Any])
        let permission = try XCTUnwrap(definitions["platformPermission"] as? [String: Any])
        let permissionFields = try XCTUnwrap(permission["fields"] as? [String: [String: Any]])
        let permissionRule = try XCTUnwrap(permissionFields["name"]?["rule"] as? [String: Any])
        let permissionNames = try XCTUnwrap(permissionRule["values"] as? [String])
        XCTAssertEqual(Set(permissionNames), PrototypePlatformValidator.permissionNames)
        let requires = try XCTUnwrap(definitions["platformRequires"] as? [String: Any])
        let requiresFields = try XCTUnwrap(requires["fields"] as? [String: [String: Any]])
        let background = try XCTUnwrap(requiresFields["background"]?["rule"] as? [String: Any])
        let backgroundItem = try XCTUnwrap(background["item"] as? [String: Any])
        let backgroundNames = try XCTUnwrap(backgroundItem["values"] as? [String])
        XCTAssertEqual(Set(backgroundNames), PrototypePlatformValidator.backgroundNames)
        let limits = try XCTUnwrap(contract["limits"] as? [String: Int])
        XCTAssertEqual(PrototypePlatformValidator.maxArgs, limits["MAX_PROTOTYPE_PLATFORM_ARGS"])
        XCTAssertEqual(PrototypePlatformValidator.maxHandlers, limits["MAX_PROTOTYPE_PLATFORM_HANDLERS"])
        XCTAssertEqual(PrototypePlatformValidator.maxTimeoutMs, limits["MAX_PROTOTYPE_PLATFORM_TIMEOUT_MS"])
    }

    func testSharedValidPlatformFixturesDecode() throws {
        let names = try fixtures("valid")
        XCTAssertGreaterThanOrEqual(names.count, 5)
        for name in names {
            let file = PrototypeSpecFixtures.directory.appendingPathComponent("valid").appendingPathComponent(name)
            XCTAssertNoThrow(try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: file)), name)
        }
    }

    func testSharedInvalidPlatformFixturesRejectAtTheHostPath() throws {
        // Repeat-bound arguments are checked by repeat expansion on the host; binding them in the
        // agent belongs to the module registry (#14296).
        let names = try fixtures("invalid").filter { $0 != "platform-repeat-unknown-item.json" }
        XCTAssertGreaterThanOrEqual(names.count, 20)
        for name in names {
            let fixture = try PrototypeSpecFixtures.invalid(String(name.dropLast(".json".count)))
            XCTAssertThrowsError(try fixture.decode(), name) { error in
                guard case let DecodingError.dataCorrupted(context) = error else { return XCTFail("\(name): \(error)") }
                XCTAssertTrue(
                    context.debugDescription.hasPrefix(fixture.expectedPath + ":"),
                    "\(name): \(context.debugDescription)"
                )
            }
        }
    }

    func testStrictValidatorRejectsUnknownRepeatPlatformArgument() throws {
        let file = PrototypeSpecFixtures.directory.appendingPathComponent("invalid/platform-repeat-unknown-item.json")
        let raw = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file))
        let spec = try XCTUnwrap(raw.objectFields?["spec"])
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: JSONEncoder().encode(spec))) { error in
            guard case let PrototypeLoadError.invalidSpec(path, _) = error else { return XCTFail("\(error)") }
            XCTAssertEqual(path, "root.children[0].onTap[0].args.message")
        }
    }

    func testPlatformPlaceholdersScanLikeDataPlaceholders() {
        XCTAssertEqual(PrototypePlatformValidator.placeholders("a {platform:/test/n} b"), ["/test/n"])
        XCTAssertEqual(PrototypePlatformValidator.placeholders("{platform:x} {platform:/a}{data:/b}"), ["/a"])
        XCTAssertEqual(PrototypePlatformValidator.placeholders("{platform:/unclosed"), [])
    }

    func testPlatformConditionsCompareAgainstAMissingValue() throws {
        let json = """
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"requires":{"platform":["test"]},
         "root":{"type":"column","children":[
           {"type":"text","text":"eq","visibleWhen":{"platform":"/test/n","equals":1}},
           {"type":"text","text":"ne","visibleWhen":{"platform":"/test/n","notEquals":1}}
         ]}}
        """
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
        let children = try XCTUnwrap(spec.root.children)
        XCTAssertEqual(children[0].visibleWhen?.holds([:]), false)
        XCTAssertEqual(children[1].visibleWhen?.holds([:]), true)
    }
}
