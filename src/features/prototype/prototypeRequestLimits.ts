import contract from "../../../schemas/prototype-spec-contract.json";

/**
 * Limits for the prototype `request` action (#12518). The shared spec contract
 * (`schemas/prototype-spec-contract.json` `limits`, #12523) is the single source, so the spec
 * validator, the host executor (#12527) and the native runtimes cannot drift apart.
 */
export const {
  DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS,
  /** The ceiling for a request's `timeoutMs`; a larger value is clamped by the host. */
  MAX_PROTOTYPE_REQUEST_TIMEOUT_MS,
  /**
   * Largest response body the host reads; a larger body fails with `too_large`. Never above
   * `MAX_PROTOTYPE_DATA_WRITE_BYTES`, so any accepted response can still be one `/data` write.
   */
  MAX_PROTOTYPE_RESPONSE_BYTES,
  /** Concurrent requests per device; the host refuses more with `too_many_in_flight`. */
  MAX_PROTOTYPE_REQUESTS_IN_FLIGHT,
} = contract.limits;
