/**
 * Error fidelity — recorded in docs/research/procedure-framework.md.
 *
 * Across a serialising transport the message, the structured `data` and the
 * original stack all arrive, because the link carries them: oRPC does not
 * marshal errors behind the caller's back, so fidelity is the link's choice,
 * and the `Rethrow` plugin is an HTTP-adapter concern AgentForge does not need.
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
  it('carries a raw error’s name, message and original stack', async () => {
    const client = createSerialisingClient({ carryStack: true });

    const rejection = client.ThrowError({ kind: 'RAW' });

    await expect(rejection).rejects.not.toBeInstanceOf(ORPCError);
    await expect(rejection).rejects.toMatchObject({
      name: 'Error',
      message: 'a raw error with a real stack',
      stack: expect.stringContaining(throwingModulePath),
    });
  });

  it('loses the original stack when the link does not carry it — the check can fail', async () => {
    const client = createSerialisingClient({ carryStack: false });

    const rejection = client.ThrowError({ kind: 'RAW' });

    await expect(rejection).rejects.toMatchObject({
      message: 'a raw error with a real stack',
      stack: expect.not.stringContaining(throwingModulePath),
    });
  });

  it('carries an ORPCError’s code, message and structured data', async () => {
    const client = createSerialisingClient({ carryStack: true });

    const rejection = client.ThrowError({ kind: 'ORPC_ERROR' });

    await expect(rejection).rejects.toBeInstanceOf(ORPCError);
    await expect(rejection).rejects.toMatchObject({
      code: 'LEASE_LOST',
      message: 'the lease generation was stale',
      data: { generation: 7 },
    });
  });
});
