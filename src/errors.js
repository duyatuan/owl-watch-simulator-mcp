/**
 * An expected, explainable failure: the simulator is not running, a permission
 * is missing, the build failed. `code` is stable and machine-readable; `hint`
 * says what to do about it.
 */
export class CiqError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ hint?: string, details?: Record<string, unknown>, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CiqError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }
}

/** @param {unknown} error */
export function describeError(error) {
  if (error instanceof CiqError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.hint ? { hint: error.hint } : {}),
      ...(error.details ? { details: error.details } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'internal', message };
}
