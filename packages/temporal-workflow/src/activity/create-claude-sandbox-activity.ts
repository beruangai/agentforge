import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { z } from 'zod';
import type { CreateClaudeSandboxActivityConfig } from './types.js';
import { classifyError } from './error-classification.js';
import { getTraceEnvVars } from '../tracing/trace-env.js';

/**
 * Create a Temporal activity function that wraps SandboxRunner.execute()
 * with heartbeat management, gateway integration, output validation,
 * and error classification.
 */
export function createClaudeSandboxActivity<TInput, TOutput>(
  config: CreateClaudeSandboxActivityConfig<TInput, TOutput>,
): (input: TInput) => Promise<TOutput> {
  const {
    name,
    runner,
    gateway,
    sandbox,
    outputSchema,
    heartbeatInterval = 15_000,
    timeout,
  } = config;

  return async (input: TInput): Promise<TOutput> => {
    const ctx = Context.current();
    const heartbeatTimer = setInterval(
      () => ctx.heartbeat(),
      heartbeatInterval,
    );

    try {
      // Build sandbox config from activity input
      const activityConfig = sandbox(input);

      // Generate mcpServers from gateway + tool filters
      let mcpServers = activityConfig.mcpServers;
      if (gateway && activityConfig.tools) {
        mcpServers = {
          ...mcpServers,
          ...gateway.mcpServersConfig(activityConfig.tools),
        };
      }

      // Build outputFormat from Zod schema if provided
      const outputFormat = outputSchema
        ? (z.toJSONSchema(outputSchema, { target: 'draft-07' }) as Record<
            string,
            unknown
          >)
        : activityConfig.outputFormat;

      // Get trace env vars for container propagation
      const traceEnv = await getTraceEnvVars();

      // Execute in container
      const result = await runner.execute({
        input: {
          name,
          prompt: activityConfig.prompt,
          model: activityConfig.model,
          maxTurns: activityConfig.maxTurns,
          allowedTools: activityConfig.allowedTools,
          disallowedTools: activityConfig.disallowedTools,
          outputFormat,
          mcpServers,
          sessionId: activityConfig.sessionId,
        },
        volumes: activityConfig.volumes,
        env: { ...activityConfig.env, ...traceEnv },
        timeout,
        network: activityConfig.network,
      });

      // Handle error status
      if (result.status === 'error') {
        throw ApplicationFailure.retryable(
          result.error ?? 'Agent task failed',
          'AgentTaskError',
        );
      }

      // Validate output against schema
      if (outputSchema) {
        const parsed = outputSchema.safeParse(result.structuredOutput);
        if (!parsed.success) {
          throw ApplicationFailure.nonRetryable(
            `Output validation failed: ${(parsed as { error: { message: string } }).error.message}`,
            'SchemaValidationError',
          );
        }
        return parsed.data as TOutput;
      }

      return result.structuredOutput as TOutput;
    } catch (error) {
      if (error instanceof ApplicationFailure) {
        throw error;
      }
      throw classifyError(error);
    } finally {
      clearInterval(heartbeatTimer);
    }
  };
}
