/**
 * The procedure that throws, in a module of its own: an original stack must
 * name THIS file, which the link's file cannot satisfy by accident.
 */
import { oc } from '@orpc/contract';
import { implement, ORPCError } from '@orpc/server';
import { z } from 'zod';

/** Where the errors are thrown, which is what an original stack must name. */
export const throwingModulePath = import.meta.filename;

export const errorContract = {
  ThrowError: oc
    .input(z.object({ kind: z.enum(['RAW', 'ORPC_ERROR']) }))
    .output(z.object({})),
};

const os = implement(errorContract).$context<Record<never, never>>();

export const errorRouter = os.router({
  ThrowError: os.ThrowError.handler(async ({ input }) => {
    if (input.kind === 'RAW') {
      throw new Error('a raw error with a real stack');
    }
    throw new ORPCError('LEASE_LOST', {
      message: 'the lease generation was stale',
      data: { generation: 7 },
    });
  }),
});
