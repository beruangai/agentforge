/**
 * The container's half of every link here: resolve the procedure a link's
 * `path` names with oRPC's own `getRouter`, and run it with `call`, which is
 * how a container answers a task in process. Nothing talks to AWS or a model —
 * the hop stands in for `InvokeAgentRuntime`, which is enough to prove the seam.
 */
import {
  type AnyRouter,
  type Context,
  call,
  getRouter,
  Procedure,
  unlazy,
} from '@orpc/server';

export async function callByPath(
  router: AnyRouter,
  path: readonly string[],
  input: unknown,
  options: { context: Context; signal?: AbortSignal },
): Promise<unknown> {
  const { default: procedure } = await unlazy(getRouter(router, path));
  if (!(procedure instanceof Procedure)) {
    throw new Error(`no procedure at ${path.join('.')}`);
  }
  return call(procedure, input, options);
}
