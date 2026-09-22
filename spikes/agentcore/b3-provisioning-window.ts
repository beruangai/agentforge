/**
 * §B — the provisioning window: what a caller sees between `CreateAgentRuntime`
 * and the first invocation that works, and how long `READY` actually takes.
 *
 * §B asks whether a second container appears for one session id "including in
 * the provisioning window that returns 409". This creates a runtime, hammers it
 * from the instant of creation with ONE session id, and records every status
 * until it answers — so the 409 is observed rather than quoted, and the same
 * session id is proved to land on one container either side of the window.
 *
 * Creates a runtime and DELETES it at the end, including on failure.
 *
 * Run: AWS_PROFILE=agentforge bun agentcore/b3-provisioning-window.ts
 */
import {
  BedrockAgentCoreControlClient,
  CreateAgentRuntimeCommand,
  GetAgentRuntimeCommand,
  DeleteAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { randomUUID } from 'node:crypto';

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const ACCOUNT = '913756569129';
const IMAGE = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/agentforge/spike-a2a:v4`;
const ROLE = `arn:aws:iam::${ACCOUNT}:role/agentforge-spike-agentcore-execution`;

const control = new BedrockAgentCoreControlClient({ region: REGION });
const data = new BedrockAgentCoreClient({ region: REGION });

const name = `agentforge_spike_window_${Date.now()}`;
let runtimeId: string | undefined;

async function probe(arn: string, sessionId: string) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: {
      message: { kind: 'message', messageId: randomUUID(), role: 'user', contextId: randomUUID(), parts: [{ kind: 'data', data: { runMilliseconds: 100 } }] },
      configuration: { blocking: false },
    },
  });
  try {
    const response = await data.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: arn,
        runtimeSessionId: sessionId,
        contentType: 'application/json',
        accept: 'application/json',
        payload: Buffer.from(payload),
      }),
    );
    const body = JSON.parse(await response.response!.transformToString());
    return { ok: true as const, container: body.result?.metadata?.containerId as string };
  } catch (error: any) {
    return { ok: false as const, status: error.$metadata?.httpStatusCode, name: error.name, message: String(error.message).slice(0, 90) };
  }
}

try {
  console.log('\n§B — the provisioning window\n');
  const createdAt = Date.now();
  const created = await control.send(
    new CreateAgentRuntimeCommand({
      agentRuntimeName: name,
      agentRuntimeArtifact: { containerConfiguration: { containerUri: IMAGE } },
      roleArn: ROLE,
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: { serverProtocol: 'A2A' },
      tags: { 'agentforge:spike': 'true' },
    }),
  );
  const arn = created.agentRuntimeArn!;
  runtimeId = arn.split('/').pop();
  console.log(`  CreateAgentRuntime returned in ${Date.now() - createdAt}ms, status=${created.status}\n`);

  // One session id for the whole window, so the container it lands on can be
  // compared either side of the transition.
  const sessionId = `window-${Date.now()}-${randomUUID().replace(/-/g, '')}`;
  const seen = new Map<string, number>();
  let firstSuccessAt: number | undefined;
  let readyAt: number | undefined;

  for (let i = 0; i < 60; i++) {
    const elapsed = Date.now() - createdAt;
    const status = (await control.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }))).status;
    if (status === 'READY' && readyAt === undefined) readyAt = Date.now() - createdAt;

    const result = await probe(arn, sessionId);
    if (result.ok) {
      const short = result.container.slice(0, 8);
      seen.set(short, (seen.get(short) ?? 0) + 1);
      if (firstSuccessAt === undefined) firstSuccessAt = Date.now() - createdAt;
      console.log(`  +${String(elapsed).padStart(6)}ms  control=${String(status).padEnd(9)}  invoke=OK container=${short}`);
      if (seen.size > 0 && (Date.now() - createdAt) > (firstSuccessAt ?? 0) + 8_000) break;
    } else {
      console.log(`  +${String(elapsed).padStart(6)}ms  control=${String(status).padEnd(9)}  invoke=HTTP ${result.status} ${result.name} — ${result.message}`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  console.log('\n── what this shows ──');
  console.log(`  READY reported at            : ${readyAt ?? '—'}ms after CreateAgentRuntime`);
  console.log(`  first invocation that worked : ${firstSuccessAt ?? '—'}ms after CreateAgentRuntime`);
  console.log(`  containers serving ONE session across the window : ${[...seen.entries()].map(([c, n]) => `${c}×${n}`).join(', ')}`);
  console.log(`  distinct containers for that session : ${seen.size}${seen.size === 1 ? ' — the session held one container throughout' : ' — the session moved'}`);
} finally {
  if (runtimeId) {
    await control.send(new DeleteAgentRuntimeCommand({ agentRuntimeId: runtimeId }));
    console.log(`\n  deleted runtime ${runtimeId}\n`);
  }
}
