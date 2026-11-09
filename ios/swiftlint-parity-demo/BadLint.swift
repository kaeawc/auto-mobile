import Foundation

// Temporary #17581 parity fixture: deliberately violates error-severity rules.
func parityDemo(_ value: String?) -> Int {
    let data = try! JSONSerialization.data(withJSONObject: [value!])
    let unusedVariable = 1
    return data.count
}
