import {
  type BedrockAgentCoreControlClient,
  type CreateAgentRuntimeResponse,
  DeleteAgentRuntimeCommand,
  GetAgentRuntimeCommand,
  GetWorkloadIdentityCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { vi } from 'vitest';

/**
 * How long a runtime may take to leave CREATING, UPDATING or DELETING. On
 * platform version V2 a create or update takes minutes while the snapshot is
 * prepared (docs/research/agentcore-runtime.md §Platform version V2), and a
 * runtime sat in DELETING for about five minutes on V1.
 */
export const agentRuntimeStatusTimeoutMilliseconds = 900_000;
const workloadIdentityGoneTimeoutMilliseconds = 300_000;

/**
 * The longest `deleteAgentRuntimeUntilGone` can take: waiting out CREATING,
 * then DELETING, then the workload identity.
 */
export const agentRuntimeDeletionTimeoutMilliseconds =
  2 * agentRuntimeStatusTimeoutMilliseconds +
  workloadIdentityGoneTimeoutMilliseconds;

const failedStatuses = new Set([
  'CREATE_FAILED',
  'UPDATE_FAILED',
  'DELETE_FAILED',
]);
/** `UpdateAgentRuntime` or `DeleteAgentRuntime` before one of these is a ConflictException. */
const inProgressStatuses = new Set(['CREATING', 'UPDATING']);

export interface AgentRuntimeReference {
  readonly agentRuntimeArn: string;
  readonly agentRuntimeId: string;
  readonly workloadIdentityName: string | undefined;
}

/**
 * What deleting a runtime needs, from what `CreateAgentRuntime` returned —
 * or a throw, naming it, when that is not enough to find it again.
 */
export function agentRuntimeReferenceFrom(
  created: CreateAgentRuntimeResponse,
  agentRuntimeName: string,
): AgentRuntimeReference {
  const { agentRuntimeArn, agentRuntimeId } = created;
  if (agentRuntimeArn === undefined || agentRuntimeId === undefined) {
    throw new Error(
      `CreateAgentRuntime ${agentRuntimeName} returned no ARN or id; look for it by name and delete it`,
    );
  }
  return {
    agentRuntimeArn,
    agentRuntimeId,
    workloadIdentityName: created.workloadIdentityDetails?.workloadIdentityArn
      ?.split('/')
      .at(-1),
  };
}

/** Its status and failure reason, or `undefined` once it is gone. */
async function readAgentRuntime(
  control: BedrockAgentCoreControlClient,
  agentRuntimeId: string,
): Promise<{ status: string; failureReason: string | undefined } | undefined> {
  try {
    const current = await control.send(
      new GetAgentRuntimeCommand({ agentRuntimeId }),
    );
    return {
      status: String(current.status),
      failureReason: current.failureReason,
    };
  } catch (error) {
    if (isResourceNotFound(error)) return undefined;
    throw error;
  }
}

export async function waitForAgentRuntimeReady(
  control: BedrockAgentCoreControlClient,
  runtime: AgentRuntimeReference,
): Promise<void> {
  let lastStatus = 'not yet read';
  try {
    await vi.waitUntil(
      async () => {
        const current = await readAgentRuntime(control, runtime.agentRuntimeId);
        if (current === undefined) throw new Error('it no longer exists');
        lastStatus = current.status;
        if (failedStatuses.has(lastStatus)) {
          throw new Error(
            `${lastStatus}: ${current.failureReason ?? 'no failureReason given'}`,
          );
        }
        return lastStatus === 'READY';
      },
      { timeout: agentRuntimeStatusTimeoutMilliseconds, interval: 5_000 },
    );
  } catch (error) {
    throw new Error(
      `runtime ${runtime.agentRuntimeArn} did not become READY (last status ${lastStatus}): ${describeError(error)}`,
      { cause: error },
    );
  }
}

/**
 * Deletes a runtime and waits until it, and the workload identity AgentCore
 * minted alongside it, are gone — that one cannot be deleted by the caller.
 * `DeleteAgentRuntime` returns at once while the runtime sits in DELETING for
 * minutes, so a teardown that returned on the call would leave it outliving
 * the run.
 *
 * A runtime still CREATING or UPDATING is waited out first: deleting it then
 * is a ConflictException, which would leak it. One already DELETING is not
 * deleted twice, and one already gone is the goal.
 */
export async function deleteAgentRuntimeUntilGone(
  control: BedrockAgentCoreControlClient,
  runtime: AgentRuntimeReference,
): Promise<void> {
  let lastStatus = 'not yet read';
  try {
    await vi.waitUntil(
      async () => {
        const current = await readAgentRuntime(control, runtime.agentRuntimeId);
        lastStatus = current === undefined ? 'gone' : current.status;
        return !inProgressStatuses.has(lastStatus);
      },
      { timeout: agentRuntimeStatusTimeoutMilliseconds, interval: 10_000 },
    );
    if (lastStatus !== 'gone' && lastStatus !== 'DELETING') {
      await control.send(
        new DeleteAgentRuntimeCommand({
          agentRuntimeId: runtime.agentRuntimeId,
        }),
      );
    }
    await vi.waitUntil(
      async () => {
        const current = await readAgentRuntime(control, runtime.agentRuntimeId);
        if (current === undefined) return true;
        lastStatus = current.status;
        if (lastStatus === 'DELETE_FAILED') {
          throw new Error(
            `DELETE_FAILED: ${current.failureReason ?? 'no failureReason given'}`,
          );
        }
        return false;
      },
      { timeout: agentRuntimeStatusTimeoutMilliseconds, interval: 10_000 },
    );
    const workloadIdentityName = runtime.workloadIdentityName;
    if (workloadIdentityName !== undefined) {
      lastStatus = `runtime gone; workload identity ${workloadIdentityName} still listed`;
      await vi.waitUntil(
        async () => {
          try {
            await control.send(
              new GetWorkloadIdentityCommand({ name: workloadIdentityName }),
            );
            return false;
          } catch (error) {
            if (isResourceNotFound(error)) return true;
            throw error;
          }
        },
        { timeout: workloadIdentityGoneTimeoutMilliseconds, interval: 10_000 },
      );
    }
  } catch (error) {
    throw new Error(
      `runtime ${runtime.agentRuntimeArn} (last status ${lastStatus}): ${describeError(error)}`,
      { cause: error },
    );
  }
}

function isResourceNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'ResourceNotFoundException';
}

export function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
