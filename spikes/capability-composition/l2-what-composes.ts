/**
 * §L / D7 — WHICH kinds of configuration compose up the tree, and where each
 * one stops. The first spike used slash commands as its only marker and
 * generalised the result to everything; the documentation says the three kinds
 * follow three different rules:
 *
 *   settings.json + hooks   <cwd>/.claude/ ONLY, no parent fallback
 *   CLAUDE.md + rules       <cwd> and every parent
 *   skills/commands/agents  <cwd> and every parent UP TO THE REPOSITORY ROOT
 *
 * That distinction decides the layout. If per-layer PERMISSIONS cannot come
 * from the filesystem layers, an image layer cannot grant itself tool access,
 * and per-procedure scoping has to come from the SDK's inline `settings`.
 *
 * Probes, each needing no model reasoning:
 *   - hooks  — a SessionStart hook at each level writes a marker file
 *   - skills/commands/agents — the `system` init message lists what loaded
 *   - the repository boundary — the same, with a .git planted mid-tree
 *
 * Run: bun capability-composition/l2-what-composes.ts
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnvironment } from '../harness.ts';
import { query } from '@anthropic-ai/claude-agent-sdk';

loadEnvironment();

const root = join(tmpdir(), `agentforge-composes-${Date.now()}`);
const marks = join(root, 'marks');
const home = join(root, 'home', '.claude');
const cwd = join(root, 'agentic', 'agent', 'procedures', 'discovery');

const levels: Record<string, string> = {
  user: home,
  agenticProject: join(root, 'agentic', '.claude'),
  agent: join(root, 'agentic', 'agent', '.claude'),
  procedure: join(cwd, '.claude'),
};

function build() {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(marks, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  for (const [level, dir] of Object.entries(levels)) {
    mkdirSync(join(dir, 'commands'), { recursive: true });
    mkdirSync(join(dir, 'skills', `skill-${level.toLowerCase()}`), { recursive: true });
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'commands', `marker-${level.toLowerCase()}.md`), `---\ndescription: ${level}\n---\n\nSay ${level}.\n`);
    writeFileSync(
      join(dir, 'skills', `skill-${level.toLowerCase()}`, 'SKILL.md'),
      `---\nname: skill-${level.toLowerCase()}\ndescription: marker skill from the ${level} layer\n---\n\nSay ${level}.\n`,
    );
    writeFileSync(join(dir, 'agents', `agent-${level.toLowerCase()}.md`), `---\nname: agent-${level.toLowerCase()}\ndescription: marker subagent from ${level}\n---\n\nSay ${level}.\n`);
    // A SessionStart hook that leaves a file behind — the probe for whether
    // settings.json and hooks fall back to parent directories at all.
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${join(marks, `hook-${level.toLowerCase()}`)}` }] }] } }, null, 2),
    );
  }
}

async function run(label: string, options: any = {}) {
  const found = { commands: [] as string[], agents: [] as string[], skills: [] as string[] };
  for await (const message of query({
    prompt: 'Reply with the single word: ok',
    options: { cwd, maxTurns: 1, settingSources: ['user', 'project'], env: { ...process.env, CLAUDE_CONFIG_DIR: home }, ...options },
  } as any)) {
    const m = message as any;
    if (m.type === 'system' && m.subtype === 'init') {
      for (const c of m.slash_commands ?? []) if (String(c).includes('marker-')) found.commands.push(String(c));
      for (const a of m.agents ?? []) if (String(a).includes('agent-')) found.agents.push(String(a));
      for (const s of m.skills ?? []) if (String(s).includes('skill-')) found.skills.push(String(s));
    }
  }
  const hooks = existsSync(marks) ? readdirSync(marks) : [];
  // EXACT token matching. A substring test reads 'agent' inside
  // 'agenticproject' and reports a layer that never loaded, and `a || b` on
  // '✓'/'·' strings short-circuits on the falsy-looking '·' that is actually
  // truthy. Both were present on the first run of this spike and made the
  // agent column meaningless.
  const tokens = (list: string[]) =>
    new Set(list.map((x) => String(x).toLowerCase().replace(/^.*?(marker|skill|agent|hook)-/, '')));
  const at = (list: string[], level: string) => (tokens(list).has(level.toLowerCase()) ? '✓' : '·');
  const row = (name: string, list: string[]) =>
    `${name.padEnd(10)} user ${at(list, 'user')}  agentic ${at(list, 'agenticproject')}  agent ${at(list, 'agent')}  procedure ${at(list, 'procedure')}   ${JSON.stringify(list)}`;
  console.log(`\n  ${label}`);
  console.log(`    ${row('commands', found.commands)}`);
  console.log(`    ${row('skills', found.skills)}   ${found.skills.length === 0 ? '(none listed — may need the `skills` option)' : ''}`);
  console.log(`    ${row('subagents', found.agents)}`);
  console.log(`    ${row('hooks', hooks)}   ${JSON.stringify(hooks)}`);
}

console.log('\n§L/D7 — which kinds of configuration compose, and where each stops\n');
build();
await run('no repository anywhere');

build();
mkdirSync(join(root, 'agentic', 'agent', '.git'), { recursive: true });
writeFileSync(join(root, 'agentic', 'agent', '.git', 'HEAD'), 'ref: refs/heads/main\n');
await run('.git planted at the agent level');

build();
await run("skills: 'all'", { skills: 'all' });

rmSync(root, { recursive: true, force: true });
console.log();
