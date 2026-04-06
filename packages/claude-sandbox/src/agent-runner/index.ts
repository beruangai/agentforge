/**
 * Agent Runner — runs inside the Docker container as the entrypoint.
 *
 * Reads AgentForgeContainerInput from stdin, executes the Claude Agent SDK,
 * and emits AgentForgeContainerOutput via sentinel-wrapped stdout.
 *
 * This file is NOT part of the published npm package API.
 * It is bundled into the base Docker image.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

import type {
  AgentForgeContainerInput,
  AgentForgeContainerOutput,
} from './types.js';
import { emitError, emitSuccess } from './output.js';
import { reconstructParentTrace } from './tracing.js';

async function main() {
  // Read input from stdin
  const stdinText = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () =>
      resolve(Buffer.concat(chunks).toString('utf-8')),
    );
  });

  const input: AgentForgeContainerInput = JSON.parse(stdinText);

  const startTime = Date.now();

  // Reconstruct parent LangSmith trace context if env vars are present.
  // The SDK picks up LANGSMITH_* env vars automatically for tracing;
  // reconstructParentTrace links this run to the host's trace tree.
  reconstructParentTrace();

  try {
    let structuredOutput: unknown;
    let sessionId: string | undefined;
    let metrics: AgentForgeContainerOutput['metrics'];

    for await (const message of query({
      prompt: input.prompt as string,
      options: {
        cwd: '/workspace/task',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        allowedTools: input.allowedTools,
        disallowedTools: input.disallowedTools,
        maxTurns: input.maxTurns,
        model: input.model,
        outputFormat: input.outputFormat
          ? {
              type: 'json_schema' as const,
              schema: input.outputFormat,
            }
          : undefined,
        env: input.env,
        mcpServers: input.mcpServers as Record<string, any>,
        settingSources: ['project', 'user'],
        ...(input.sessionId ? { resume: input.sessionId } : {}),
        ...(!input.sessionId ? { sessionId: crypto.randomUUID() } : {}),
      },
    })) {
      if (message.type === 'result') {
        const result = message as Record<string, unknown>;
        if (result.subtype === 'success') {
          structuredOutput = result.structured_output;
          sessionId = result.session_id as string | undefined;
          // Extract SDK-native metrics
          metrics = {
            usage: result.usage as NonNullable<
              AgentForgeContainerOutput['metrics']
            >['usage'],
            totalCostUsd: result.total_cost_usd as number | undefined,
            durationMs:
              (result.duration_ms as number) ?? Date.now() - startTime,
            durationApiMs: result.duration_api_ms as number | undefined,
            numTurns: result.num_turns as number | undefined,
          };
        } else {
          // Error result subtypes: error_max_turns, error_during_execution, etc.
          const errors = (result.errors as string[]) ?? [];
          throw new Error(
            errors.join('; ') || `Agent query failed: ${result.subtype}`,
          );
        }
      }
    }

    emitSuccess({
      structuredOutput,
      sessionId,
      metrics,
    });
    process.exit(0);
  } catch (error) {
    emitError(error);
    process.exit(1);
  }
}

main();
