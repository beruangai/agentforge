/**
 * §I — can `A2A-Version` be forwarded after all?
 *
 * An earlier run of these spikes recorded that `InvokeAgentRuntime` never
 * forwards `A2A-Version`, and concluded that AgentForge is therefore pinned to
 * protocol 0.3 with `legacyCompat`. That was the DEFAULT behaviour stated as
 * the platform's. AgentCore supports a request header allowlist
 * (`requestHeaderConfiguration.requestHeaderAllowlist`, up to 20 headers, 4 KB
 * each), and `A2A-Version` breaks none of its restrictions — it is a valid
 * header name, is not in the restricted table, and is not `x-amz-`/`x-amzn-`.
 *
 * So: with the runtime configured to allow it, does the header arrive, and does
 * the A2A SDK then negotiate 1.0 instead of 0.3? And if it does, does the 1.0
 * part shape — which was silently stripped under 0.3 — survive?
 *
 * Run with a runtime whose allowlist contains A2A-Version and X-Agentforge-Probe.
 *   AWS_PROFILE=agentforge bun agentcore/i2-header-allowlist.ts
 */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { randomUUID } from 'node:crypto';

const RUNTIME_ARN = process.env.AGENTCORE_RUNTIME_ARN!;
if (!RUNTIME_ARN) throw new Error('set AGENTCORE_RUNTIME_ARN');

/** Headers to add to THIS call, set just before send. */
let extraHeaders: Record<string, string> = {};

const client = new BedrockAgentCoreClient({ region: process.env.AWS_REGION ?? 'us-west-2' });
// Added at the `build` step so the headers are in place before SigV4 signs —
// an unsigned header would be dropped or would break the signature.
client.middlewareStack.add(
  (next: any) => async (args: any) => {
    Object.assign(args.request.headers, extraHeaders);
    return next(args);
  },
  { step: 'build', name: 'agentforgeExtraHeaders' },
);

async function call(label: string, headers: Record<string, string>, params: any, method = 'message/send') {
  extraHeaders = headers;
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  try {
    const response = await client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: RUNTIME_ARN,
        runtimeSessionId: `hdr-${Date.now()}-${randomUUID().replace(/-/g, '')}`,
        contentType: 'application/json',
        accept: 'application/json',
        payload: Buffer.from(payload),
      }),
    );
    const body = JSON.parse(await response.response!.transformToString());
    return { label, ok: true as const, body };
  } catch (error: any) {
    return { label, ok: false as const, status: error.$metadata?.httpStatusCode, detail: error.error ? `${error.error.code} ${error.error.message}` : `${error.name}: ${error.message}` };
  } finally {
    extraHeaders = {};
  }
}

/** A part in the 0.3 wire shape. */
const part03 = { kind: 'data', data: { runMilliseconds: 200, idempotencyKey: 'hdr-03' } };
/** A part in the 1.0 protobuf shape — silently stripped under a 0.3 negotiation. */
const part10 = { content: { $case: 'data', value: { runMilliseconds: 200, idempotencyKey: 'hdr-10' } }, filename: '', mediaType: '' };

const message = (parts: any[], role: any) => ({
  message: { kind: 'message', messageId: randomUUID(), role, contextId: randomUUID(), parts },
  configuration: { blocking: false },
});

const show = (r: any) => {
  if (!r.ok) return console.log(`  ${r.label.padEnd(46)} HTTP ${r.status} ${r.detail}`);
  const m = r.body.result?.metadata ?? {};
  const e = r.body.error;
  console.log(
    `  ${r.label.padEnd(46)} ${e ? `rpc ${e.code} ${String(e.message).slice(0, 60)}` : `negotiated=${m.negotiatedVersion} idempotencyKey=${m.idempotencyKey} run=${m.runMilliseconds}`}`,
  );
};

console.log('\n§I — does the request header allowlist carry A2A-Version?\n');

show(await call('no header (the earlier default)', {}, message([part03], 'user')));
show(await call('A2A-Version: 0.3', { 'A2A-Version': '0.3' }, message([part03], 'user')));
show(await call('A2A-Version: 1.0, 0.3-shaped part', { 'A2A-Version': '1.0' }, message([part03], 'user')));
show(await call('A2A-Version: 1.0, 1.0-shaped part', { 'A2A-Version': '1.0' }, message([part10], 'user')));
show(await call('no header, 1.0-shaped part (the trap)', {}, message([part10], 'user')));
show(await call('a custom header, X-Agentforge-Probe', { 'X-Agentforge-Probe': 'hello' }, message([part03], 'user')));
show(await call('a header NOT on the allowlist', { 'X-Not-Allowlisted': 'nope' }, message([part03], 'user')));

console.log('\n  the container logs every header name it saw; read them with:');
console.log('    bash agentcore/read-headers.sh\n');
