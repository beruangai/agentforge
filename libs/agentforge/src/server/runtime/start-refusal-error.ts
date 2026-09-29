import { A2AError, type A2AErrorInfo } from '@a2a-js/sdk/errors';
import {
  type StartRefusal,
  type StartRefusalErrorInfo,
  startRefusalErrorInfo,
} from '#core/contract/start-refusal.ts';

/**
 * A start refused in-band. The A2A SDK answers an `A2AError` it has no code
 * for as `-32603` on HTTP 200 with `data: [error.toErrorInfo()]`, so the
 * refusal travels as the `agentforge` ErrorInfo, which a client reads by its
 * domain and reason, never by the code.
 */
export class StartRefusalError extends A2AError {
  readonly refusal: StartRefusal;
  readonly retryAfterSeconds: number;
  readonly #errorInfo: StartRefusalErrorInfo;

  constructor(
    refusal: StartRefusal,
    retryAfterSeconds: number,
    message: string,
  ) {
    super(message);
    this.refusal = refusal;
    this.retryAfterSeconds = retryAfterSeconds;
    // Built here, so a retry time that is not a positive whole number throws where it is decided.
    this.#errorInfo = startRefusalErrorInfo(refusal, retryAfterSeconds);
  }

  /** The SDK types an ErrorInfo's domain as A2A's own; this one is `agentforge`. */
  override toErrorInfo(): A2AErrorInfo {
    return this.#errorInfo as unknown as A2AErrorInfo;
  }
}
