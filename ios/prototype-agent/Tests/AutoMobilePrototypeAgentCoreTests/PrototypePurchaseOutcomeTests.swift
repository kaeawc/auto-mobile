@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

private typealias Purchase = PrototypePurchaseOutcome

final class PrototypePurchaseOutcomeTests: XCTestCase {
    private func text(_ fields: [String: JSONValue], _ key: String) throws -> String {
        try XCTUnwrap(fields[key]?.stringValue, "Expected string \(key)")
    }

    private func stateOf(_ value: JSONValue) throws -> Purchase.State {
        let fields = try XCTUnwrap(value.objectFields)
        let entitlements = try XCTUnwrap(fields["entitlements"]?.objectFields).mapValues {
            try XCTUnwrap($0.stringValue)
        }
        let raw = try XCTUnwrap(fields["lastTransaction"])
        var transaction: Purchase.Transaction?
        if raw != .null {
            let fields = try XCTUnwrap(raw.objectFields)
            transaction = try Purchase.Transaction(
                transactionId: text(fields, "transactionId"), productId: text(fields, "productId"),
                status: text(fields, "status")
            )
        }
        return Purchase.State(entitlements: entitlements, lastTransaction: transaction)
    }

    private func outcomeOf(_ value: JSONValue) throws -> Purchase.Outcome {
        let fields = try XCTUnwrap(value.objectFields)
        if let error = fields["error"]?.objectFields {
            return try .failure(Purchase.Error(
                code: text(error, "code"), message: text(error, "message"), reason: error["reason"]?.stringValue
            ))
        }
        let result = try XCTUnwrap(fields["result"]?.objectFields)
        return try .result(status: text(result, "status"), transactionId: text(result, "transactionId"))
    }

    private func stepJson(_ step: Purchase.Step) -> JSONValue {
        let transaction: JSONValue = step.state.lastTransaction.map {
            .object([
                "transactionId": .string($0.transactionId), "productId": .string($0.productId),
                "status": .string($0.status),
            ])
        } ?? .null
        var fields: [String: JSONValue] = [
            "state": .object([
                "entitlements": .object(step.state.entitlements.mapValues(JSONValue.string)),
                "lastTransaction": transaction,
            ]),
            "entitlementsChanged": .bool(step.entitlementsChanged),
        ]
        if let into = step.into {
            fields["into"] = .object([
                "status": .string(into.status), "transactionId": .string(into.transactionId),
            ])
        }
        if let error = step.error {
            var fieldsForError: [String: JSONValue] = [
                "code": .string(error.code), "message": .string(error.message),
            ]
            if let reason = error.reason { fieldsForError["reason"] = .string(reason) }
            fields["error"] = .object(fieldsForError)
        }
        return .object(fields)
    }

    private func apply(
        _ products: [Purchase.Product], _ state: Purchase.State, _ step: [String: JSONValue]
    )
        throws -> Purchase.Step
    {
        switch try text(step, "op") {
        case "purchase":
            return try Purchase.purchase(
                products, state, text(step, "productId"), outcomeOf(XCTUnwrap(step["outcome"]))
            )
        case "resolve":
            return try Purchase.resolve(products, state, text(step, "transactionId"), text(step, "resolution"))
        case "entitlement":
            return try Purchase.entitlementChange(products, state, text(step, "productId"), text(step, "change"))
        default:
            XCTFail("Unknown purchase fixture operation")
            return Purchase.Step(state: state)
        }
    }

    func testSharedPurchaseCorpus() throws {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-purchase", isDirectory: true)
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        XCTAssertFalse(files.isEmpty, "test/fixtures/prototype-purchase is empty")
        for file in files {
            let fixture = try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file)).objectFields)
            let name = try text(fixture, "name")
            guard case let .array(rawProducts)? = fixture["products"],
                  case let .array(steps)? = fixture["steps"]
            else { return XCTFail("Expected products and steps in \(file.lastPathComponent)") }
            let products = try rawProducts.map { raw in
                let fields = try XCTUnwrap(raw.objectFields)
                return try Purchase.Product(id: text(fields, "id"), kind: text(fields, "kind"))
            }
            XCTAssertFalse(steps.isEmpty, "\(file.lastPathComponent) has no steps")
            var state = try stateOf(XCTUnwrap(fixture["state"]))
            for (index, raw) in steps.enumerated() {
                let step = try XCTUnwrap(raw.objectFields)
                let result = try apply(products, state, step)
                let expected = try XCTUnwrap(step["expect"])
                XCTAssertEqual(stepJson(result), expected, "\(file.lastPathComponent): \(name), step \(index)")
                state = result.state
            }
        }
    }

    func testTransactionIdBoundsUseUTF16() {
        let products = [Purchase.Product(id: "coins", kind: "consumable")]
        for (id, valid) in [
            ("", false),
            ("x", true),
            (String(repeating: "x", count: 64), true),
            (String(repeating: "x", count: 65), false),
            (String(repeating: "😀", count: 32), true),
            (String(repeating: "😀", count: 33), false),
        ] {
            let step = Purchase.purchase(
                products,
                Purchase.State(),
                "coins",
                .result(status: "purchased", transactionId: id)
            )
            if valid {
                XCTAssertEqual(step.into, Purchase.Into(status: "purchased", transactionId: id))
                XCTAssertEqual(step.state.lastTransaction, Purchase.Transaction(
                    transactionId: id, productId: "coins", status: "purchased"
                ))
                XCTAssertNil(step.error)
            } else {
                XCTAssertEqual(step.error, Purchase.Error(code: "platform_error", message: "Invalid transaction id"))
                XCTAssertEqual(step.state, Purchase.State())
                XCTAssertNil(step.into)
            }
            XCTAssertFalse(step.entitlementsChanged)
        }
    }

    func testErrorTypingAndPurchasePrecedence() {
        let products = [Purchase.Product(id: "pro", kind: "subscription")]
        let state = Purchase.State(entitlements: ["pro": "active"])
        let error = Purchase.Error(code: "unknown", message: "boom", reason: "network")
        XCTAssertEqual(
            Purchase.purchase(products, Purchase.State(), "pro", .failure(error)),
            Purchase.Step(state: Purchase.State(), error: Purchase.Error(
                code: "platform_error", message: "boom", reason: "network"
            ))
        )
        XCTAssertEqual(
            Purchase.purchase(products, state, "pro", .failure(error)),
            Purchase.Step(state: state, error: Purchase.Error(code: "alreadyOwned", message: "pro is already owned"))
        )
        XCTAssertEqual(
            Purchase.purchase(products, state, "missing", .failure(error)),
            Purchase.Step(state: state, error: Purchase.Error(
                code: "platform_error", message: "Unknown product missing", reason: "unavailable"
            ))
        )
    }

    func testResolutionOnlyFlagsRealEntitlementChanges() {
        for kind in ["consumable", "subscription"] {
            let products = [Purchase.Product(id: "pro", kind: kind)]
            let state = Purchase.State(
                entitlements: kind == "subscription" ? ["pro": "active"] : [:],
                lastTransaction: Purchase.Transaction(transactionId: "t", productId: "pro", status: "pending")
            )
            let step = Purchase.resolve(products, state, "t", "approved")
            XCTAssertEqual(step, Purchase.Step(state: Purchase.State(
                entitlements: state.entitlements,
                lastTransaction: Purchase.Transaction(transactionId: "t", productId: "pro", status: "purchased")
            )))
            XCTAssertEqual(Purchase.resolve([], state, "t", "approved"), Purchase.Step(
                state: state,
                error: Purchase.Error(code: "platform_error", message: "Unknown product pro", reason: "unavailable")
            ))
        }
    }
}
