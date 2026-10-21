# Session broker replies

`fake-lifecycle.json` was captured from the real `SessionBroker` using
`createFakeBrokerScenarioContext` with an in-memory SQLite store and the shared fake
native port. It contains unmodified prepare, status, capacity refusal, release, and
released-status replies. No retained `session-broker-native` JSON evidence was
available in this lane. These replies establish the product envelope and state
contract; they do not establish native destruction or socket behavior.
