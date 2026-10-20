package dev.jasonpearson.automobile.desktop.core.telemetry

internal inline fun TelemetryDisplayEvent.Storage.anyStorageField(
  predicate: (String) -> Boolean,
): Boolean =
  predicate(fileName) ||
    key?.let(predicate) == true ||
    value?.let(predicate) == true ||
    predicate(changeType)

internal inline fun TelemetryDisplayEvent.Failure.anyFailureField(
  predicate: (String) -> Boolean,
): Boolean =
  predicate(type) ||
    predicate(title) ||
    exceptionType?.let(predicate) == true ||
    screen?.let(predicate) == true

internal inline fun TelemetryDisplayEvent.Os.anyOsField(predicate: (String) -> Boolean): Boolean =
  predicate(category) || predicate(kind) || details?.values?.any(predicate) == true

internal inline fun TelemetryDisplayEvent.Navigation.anyNavigationField(
  predicate: (String) -> Boolean,
): Boolean =
  predicate(destination) ||
    source?.let(predicate) == true ||
    triggeringInteraction?.let(predicate) == true ||
    arguments?.values?.any(predicate) == true

internal inline fun TelemetryDisplayEvent.Log.anyLogField(predicate: (String) -> Boolean): Boolean =
  predicate(tag) || predicate(message)

internal inline fun TelemetryDisplayEvent.Network.anyNetworkField(
  predicate: (String) -> Boolean,
): Boolean =
  predicate(method) ||
    predicate("$statusCode") ||
    predicate(url) ||
    host?.let(predicate) == true ||
    path?.let(predicate) == true ||
    error?.let(predicate) == true
