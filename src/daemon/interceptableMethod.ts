/**
 * A typed test handle on one instance method: `call` invokes it, and `intercept` wraps it for the
 * instance and returns a function that restores the original. Used by `testHooks` getters so tests
 * can observe or delay internal steps without reaching into private members.
 */
export interface InterceptableMethod<F> {
  readonly call: F;
  intercept(wrap: (original: F) => F): () => void;
}

export function interceptableMethod<F>(
  current: () => F,
  install: (replacement: F) => void,
): InterceptableMethod<F> {
  return {
    get call() {
      return current();
    },
    intercept: (wrap) => {
      const original = current();
      install(wrap(original));
      return () => install(original);
    },
  };
}
