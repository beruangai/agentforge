/**
 * §I — can AgentForge run A2A 1.0 ONLY, and never carry 0.3?
 *
 * The operator's position: A2A is the transport, it is never exposed to agents
 * or to consumers, and there is no reason to build or support a legacy version.
 * The question is whether `@a2a-js/sdk@1.2.0` permits it — a card declaring one
 * interface, `legacyCompat` off — and what a 0.3 caller then gets.
 *
 * This also reverses advice given earlier in the same session. "Keep
 * legacyCompat enabled as a safety net" was wrong: with it ON, a missing
 * `A2A-Version` allowlist entry downgrades every call to 0.3 and everything
 * appears to work on the wrong protocol. With it OFF the same mistake fails
 * loudly. Zero silent failures wants it off.
 *
 * Runs two servers side by side, strict and permissive, and probes both with
 * the same matrix. No AWS: the AgentCore half — that an allowlisted
 * `A2A-Version` arrives and drives negotiation — is already measured.
 *
 * Run: bun agentcore/i3-strict-10.ts
 */
import { randomUUID } from 'node:crypto';

const STRICT = 9101;
const PERMISSIVE = 9102;

/**
 * A UNIQUE key per probe. The gateway's own idempotency index returns the
 * first task for a repeated key, so a shared constant made every probe echo
 * the first result — which on the first run of this spike reported the
 * permissive server as negotiating 0.3 for every case, including ones that
 * negotiate 1.0. The measurement was defeated by the thing being measured.
 */
const freshPayload = () => ({ runMilliseconds: 50, idempotencyKey: `probe-${randomUUID()}` });
const wirePart = () => ({ kind: 'data', data: freshPayload() });
const protoPart = () => ({ content: { $case: 'data', value: freshPayload() }, filename: '', mediaType: '' });

async function probe(port: number, method: string, makePart: () => any, role: any, version?: string) {
  const part = makePart();
  const headers: Record<string, string> = {};
  if (version) headers['A2A-Version'] = version;
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method,
    params: { message: { kind: 'message', messageId: randomUUID(), role, contextId: randomUUID(), parts: [part] }, configuration: { blocking: false } },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers, body });
    const json: any = await response.json();
    if (json.error) return `rpc ${json.error.code} ${String(json.error.message).slice(0, 46)}`;
    const m = json.result?.metadata ?? json.result?.task?.metadata ?? {};
    const sent = (part.data ?? part.content?.value)?.idempotencyKey;
    return `OK v=${m.negotiatedVersion}${m.idempotencyKey === sent ? '' : ' [STALE — idempotency echo]'}`;
  } catch (error: any) {
    return `transport ${error.message}`;
  }
}

const cases: [string, string, () => any, any, string | undefined][] = [
  ['no header,       message/send, wire part', 'message/send', wirePart, 'user', undefined],
  ['A2A-Version 1.0, message/send, wire part', 'message/send', wirePart, 'user', '1.0'],
  ['A2A-Version 0.3, message/send, wire part', 'message/send', wirePart, 'user', '0.3'],
  ['no header,       SendMessage,  wire part', 'SendMessage', wirePart, 'user', undefined],
  ['A2A-Version 1.0, SendMessage,  wire part', 'SendMessage', wirePart, 'user', '1.0'],
  ['A2A-Version 0.3, SendMessage,  wire part', 'SendMessage', wirePart, 'user', '0.3'],
  ['A2A-Version 1.0, SendMessage,  proto part', 'SendMessage', protoPart, 1, '1.0'],
];

console.log('\n§I — 1.0 only, or 1.0 with 0.3 underneath?\n');
console.log(`  ${''.padEnd(43)} ${'STRICT (1.0 card, legacyCompat off)'.padEnd(38)} PERMISSIVE (both, legacyCompat on)`);
for (const [label, method, part, role, version] of cases) {
  const strict = await probe(STRICT, method, part, role, version);
  const permissive = await probe(PERMISSIVE, method, part, role, version);
  console.log(`  ${label.padEnd(43)} ${strict.padEnd(38)} ${permissive}`);
}

console.log('\n  the cards each server serves:\n');
for (const [name, port] of [['strict', STRICT], ['permissive', PERMISSIVE]] as const) {
  const card: any = await (await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`)).json();
  console.log(`  ${name.padEnd(12)} ${JSON.stringify(card.supportedInterfaces.map((i: any) => i.protocolVersion))}`);
}
console.log();

// ── does the SDK's OWN client speak 1.0 against a 1.0-only card? ─────────────
// This is the part that decides whether "1.0 only" is configuration or code.
// AgentForge owns both ends — the client is its own and A2A is never exposed
// to a consumer or an agent — so if the client follows the card, there is
// nothing to hand-roll.
const { ClientFactory, JsonRpcTransportFactory } = await import('@a2a-js/sdk/client');

for (const [name, port] of [['strict', STRICT], ['permissive', PERMISSIVE]] as const) {
  const card: any = await (await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`)).json();
  let sawVersion: string | undefined;
  let sawMethod: string | undefined;
  const fetchImpl = async (input: any, init: any) => {
    sawVersion = new Headers(init?.headers).get('A2A-Version') ?? undefined;
    try { sawMethod = JSON.parse(init?.body ?? '{}').method; } catch {}
    return fetch(input, init);
  };
  const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })] } as any);
  try {
    const client: any = await factory.createFromAgentCard(card);
    // The SDK is protobuf-TYPED: a part written the way the specification
    // documents it (`{kind:'data',data}`) serialises to an empty part, with no
    // error. The client must be handed the SDK's own shape, which it then puts
    // on the wire in the form the server decodes.
    const result: any = await client.sendMessage({
      message: {
        messageId: randomUUID(), role: 1, contextId: randomUUID(), taskId: '',
        parts: [{ content: { $case: 'data', value: freshPayload() }, filename: '', mediaType: '' }],
        extensions: [], referenceTaskIds: [],
      },
      configuration: { returnImmediately: true, acceptedOutputModes: [] },
    } as any);
    const m = result?.metadata ?? result?.task?.metadata ?? {};
    console.log(`  ${name.padEnd(12)} client sent A2A-Version=${String(sawVersion).padEnd(10)} method=${String(sawMethod).padEnd(13)} -> server negotiated ${m.negotiatedVersion}`);
  } catch (error: any) {
    console.log(`  ${name.padEnd(12)} client sent A2A-Version=${String(sawVersion).padEnd(10)} method=${String(sawMethod).padEnd(13)} -> ${String(error.message).slice(0, 60)}`);
  }
}
console.log();
