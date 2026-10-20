package dev.jasonpearson.automobile.ctrlproxy.prototype

/**
 * Renderer internals that AutoMobile's own CtrlProxy host builds on. They change without notice;
 * embedding apps use the stable entry point instead.
 */
@RequiresOptIn(
  message = "AutoMobile host API: not stable for apps embedding the prototype renderer.",
  level = RequiresOptIn.Level.ERROR,
)
@Retention(AnnotationRetention.BINARY)
@Target(
  AnnotationTarget.CLASS,
  AnnotationTarget.FUNCTION,
  AnnotationTarget.PROPERTY,
  AnnotationTarget.CONSTRUCTOR,
  AnnotationTarget.TYPEALIAS,
)
annotation class InternalAutoMobilePrototypeApi
