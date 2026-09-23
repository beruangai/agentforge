/// <reference lib="esnext.disposable" />

/**
 * What a test file creates in AWS is deferred onto an `AsyncDisposableStack`
 * the moment it exists, and released in `afterAll`, which vitest runs even
 * when `beforeAll` failed halfway — so a partial setup is torn down too.
 * Release runs last-in first-out and attempts every step.
 */
export function createResourceStack(): AsyncDisposableStack {
  return new AsyncDisposableStack();
}

/**
 * Releases every resource, and throws — naming each failure — if any step
 * failed, so a teardown that leaves something behind fails the run loudly
 * rather than printing a warning nobody reads.
 */
export async function releaseResources(
  stack: AsyncDisposableStack,
  testFile: string,
): Promise<void> {
  try {
    await stack.disposeAsync();
  } catch (error) {
    const failures = unwrapSuppressedErrors(error);
    throw new AggregateError(
      failures,
      `${testFile}: teardown left AWS resources behind (tagged agentforge:integ=true):\n${failures
        .map((failure) =>
          failure instanceof Error
            ? `  - ${failure.message}`
            : `  - ${String(failure)}`,
        )
        .join('\n')}`,
    );
  }
}

/** `disposeAsync` chains a second failure onto the first as a `SuppressedError`. */
function unwrapSuppressedErrors(error: unknown): unknown[] {
  if (error instanceof SuppressedError) {
    return [
      ...unwrapSuppressedErrors(error.suppressed),
      ...unwrapSuppressedErrors(error.error),
    ];
  }
  return [error];
}
