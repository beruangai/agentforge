import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `claude` binary the Agent SDK ships in its platform package
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`), resolved from the SDK
 * itself, so a test runs the CLI version AgentForge pins rather than whatever
 * is on `PATH`.
 */
export function claudeCodeExecutable(): string {
  const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const requireFromSdk = createRequire(
    fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk')),
  );
  const executable = join(
    dirname(requireFromSdk.resolve(`${platformPackage}/package.json`)),
    'claude',
  );
  if (!existsSync(executable)) {
    throw new Error(`${platformPackage} has no claude binary at ${executable}`);
  }
  return executable;
}
