/**
 * §L / D7 — does the Agent SDK compose capabilities from NESTED directories
 * above `cwd`, or only from one project root?
 *
 * This is load-bearing. The operator's design layers capabilities by image —
 * base image, agentic project, agent, and optionally procedure — each
 * contributing a `.claude/` directory at its own level, with `cwd` set at the
 * deepest. That only works if project-scope discovery walks UP from `cwd`.
 *
 * The documentation contradicts itself on exactly this point, read 2026-09-22:
 *   - the TypeScript SDK reference says project settings are "discovered
 *     upward from cwd. Claude Code traverses up the directory tree."
 *   - the .claude directory reference says "Claude Code does NOT walk up
 *     parent directories. Discovery is strictly scoped."
 *
 * So it is measured, not read. Each level contributes a uniquely named slash
 * command; the SDK's `system` init message lists the commands it actually
 * loaded, so the probe needs no model reasoning and costs almost nothing.
 *
 * Run: bun capability-composition/l1-nested-scopes.ts
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnvironment } from '../harness.ts';
import { query } from '@anthropic-ai/claude-agent-sdk';

loadEnvironment();

const root = join(tmpdir(), `agentforge-scopes-${Date.now()}`);

/** The layering the operator proposed, one `.claude/` per image layer. */
const levels = {
  user: join(root, 'home', '.claude'),
  agenticProject: join(root, 'agentic', '.claude'),
  agent: join(root, 'agentic', 'agent', '.claude'),
  procedure: join(root, 'agentic', 'agent', 'procedures', 'discovery', '.claude'),
};
const cwd = join(root, 'agentic', 'agent', 'procedures', 'discovery');

for (const [level, directory] of Object.entries(levels)) {
  mkdirSync(join(directory, 'commands'), { recursive: true });
  writeFileSync(
    join(directory, 'commands', `marker-${level.toLowerCase()}.md`),
    `---\ndescription: marker contributed by the ${level} layer\n---\n\nSay "${level}".\n`,
  );
  writeFileSync(join(directory, 'CLAUDE.md'), `Layer marker: ${level}.\n`);
}
mkdirSync(cwd, { recursive: true });

console.log('\n§L/D7 — do nested .claude directories above cwd compose?\n');
console.log(`  cwd  ${cwd.replace(root, '<root>')}`);
for (const [level, directory] of Object.entries(levels)) console.log(`  ${level.padEnd(15)} ${directory.replace(root, '<root>')}`);

async function probe(label: string, settingSources: any) {
  const commands: string[] = [];
  try {
    for await (const message of query({
      prompt: 'Reply with the single word: ok',
      options: {
        cwd,
        settingSources,
        maxTurns: 1,
        env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, 'home', '.claude') },
      } as any,
    })) {
      if ((message as any).type === 'system' && (message as any).subtype === 'init') {
        for (const c of (message as any).slash_commands ?? []) if (String(c).startsWith('marker-')) commands.push(String(c));
      }
    }
  } catch (error: any) {
    console.log(`  ${label.padEnd(38)} FAILED ${String(error.message).slice(0, 70)}`);
    return;
  }
  const seen = (name: string) => (commands.some((c) => c.includes(name)) ? '✓' : '·');
  console.log(
    `  ${label.padEnd(38)} user ${seen('user')}  agenticProject ${seen('agenticproject')}  agent ${seen('agent')}  procedure ${seen('procedure')}   ${JSON.stringify(commands)}`,
  );
}

console.log();
await probe("settingSources ['user','project']", ['user', 'project']);
await probe("settingSources ['project']", ['project']);
await probe('settingSources omitted (default)', undefined);

// ── does a .git boundary stop the walk? ─────────────────────────────────────
// Load-bearing: an agent image may well contain a git repository, and if a
// repository root halts discovery then every layer ABOVE it goes dark.
mkdirSync(join(root, 'agentic', 'agent', '.git'), { recursive: true });
writeFileSync(join(root, 'agentic', 'agent', '.git', 'HEAD'), 'ref: refs/heads/main\n');
console.log();
await probe('with a .git at the agent level', ['user', 'project']);

// ── do additionalDirectories contribute capabilities, or only read access? ──
// The SDK reference says that with the `project` source enabled it also loads
// "the directory's skills, commands, and subagents" — which would mean a
// mounted working directory can inject capabilities, not merely be readable.
const mounted = join(root, 'mnt', 'workdir', 'vault');
mkdirSync(join(mounted, '.claude', 'commands'), { recursive: true });
writeFileSync(
  join(mounted, '.claude', 'commands', 'marker-mounted.md'),
  '---\ndescription: marker contributed by a MOUNTED additional directory\n---\n\nSay "mounted".\n',
);
{
  const commands: string[] = [];
  for await (const message of query({
    prompt: 'Reply with the single word: ok',
    options: {
      cwd, settingSources: ['user', 'project'], maxTurns: 1,
      additionalDirectories: [mounted],
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, 'home', '.claude') },
    } as any,
  })) {
    if ((message as any).type === 'system' && (message as any).subtype === 'init') {
      for (const c of (message as any).slash_commands ?? []) if (String(c).startsWith('marker-')) commands.push(String(c));
    }
  }
  const mountedSeen = commands.some((c) => c.includes('mounted'));
  console.log(`  ${'additionalDirectories: a mounted dir'.padEnd(38)} mounted ${mountedSeen ? '✓ CONTRIBUTES CAPABILITIES' : '· read access only'}   ${JSON.stringify(commands)}`);
}

console.log(`\n  A '✓' on agenticProject or agent means discovery walks UP from cwd,`);
console.log(`  and the operator's layered scheme works as designed. Only 'procedure'`);
console.log(`  and 'user' means it does not, and each layer must be composed into a`);
console.log(`  single project directory at build time instead.\n`);

rmSync(root, { recursive: true, force: true });
