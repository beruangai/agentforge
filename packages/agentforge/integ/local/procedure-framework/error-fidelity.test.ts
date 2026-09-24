/**
 * Error fidelity — recorded in docs/research/procedure-framework.md.
 *
 * Only what oRPC itself provides: `call` hands a raw error back as itself, with
 * its original stack, and an `ORPCError` crosses a serialising transport with
 * its code, message and structured `data`. How a raw error's stack would cross
 * is the link's own code, and not tested here.
 */
import { ORPCError } from '@orpc/client';
import { call } from '@orpc/server';
import { describe, expect, it } from 'vitest';
import { createSerialisingClient } from './__fixtures__/error-fidelity.ts';
import {
  errorRouter,
  throwingModulePath,
} from './__fixtures__/error-throwing-router.ts';

describe('in process', () => {
  it('lets a raw error through as itself, with its message and its stack', async () => {
    const rejection = call(
      errorRouter.ThrowError,
      { kind: 'RAW' },
      { context: {} },
    );

    await expect(rejection).rejects.not.toBeInstanceOf(ORPCError);
    await expect(rejection).rejects.toMatchObject({
      message: 'a raw error with a real stack',
      stack: expect.stringContaining(throwingModulePath),
    });
  });
});

describe('across a serialising transport', () => {
  it('carries an ORPCError’s code, message and structured data', async () => {
    const client = createSerialisingClient();

    const rejection = client.ThrowError({ kind: 'ORPC_ERROR' });

    await expect(rejection).rejects.toBeInstanceOf(ORPCError);
    await expect(rejection).rejects.toMatchObject({
      code: 'LEASE_LOST',
      message: 'the lease generation was stale',
      data: { generation: 7 },
    });
  });
});
