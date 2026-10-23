import path from 'node:path';
import { setupMeter, setupTracer } from '@strands-agents/sdk/telemetry';
import { AGENT_NAME_VARIABLE } from '#core/agent-name.ts';
import type {
  Framework,
  FrameworkRunner,
} from '../../../server/harness/framework.ts';
import { REQUIRED_SECRETS } from '../core/secrets.ts';
import { strandsAgentOptionsMiddleware } from './agent-options.ts';
import { type RunnerContext, runAgent } from './runner.ts';
import { storageFromEnvironment } from './storage.ts';
import type { StrandsTypes } from './types.ts';

const [API_KEY_VARIABLE] = REQUIRED_SECRETS;

/** The runner a `strands` task process runs its agent runs through, over the context it was given. */
export function strandsRunner(
  context: RunnerContext,
): FrameworkRunner<StrandsTypes> {
  return {
    runAgent: (spec, environment) => runAgent(spec, environment, context),
  };
}

/**
 * The runner's context from the task process's environment: the API key, the
 * deployment's storage under the agent's name, the layers — the agent's
 * directory, its cwd, and the base layer above it — and the exporters the
 * server's telemetry level names (§REQ602).
 */
export function runnerContextFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): RunnerContext {
  const apiKey = environment[API_KEY_VARIABLE];
  if (apiKey === undefined || apiKey === '') {
    throw new Error(
      `${API_KEY_VARIABLE} is unset: a strands agent's runs authenticate with it (§REQ714)`,
    );
  }
  const storage = storageFromEnvironment(environment);
  const agentName = environment[AGENT_NAME_VARIABLE];
  const tracer =
    environment.OTEL_TRACES_EXPORTER === 'otlp'
      ? setupTracer({ exporters: { otlp: true } })
      : undefined;
  const meter =
    environment.OTEL_METRICS_EXPORTER === 'otlp'
      ? setupMeter({ exporters: { otlp: true } })
      : undefined;
  return {
    apiKey,
    layers: [path.dirname(cwd), cwd],
    ...(storage === undefined ? {} : { storage }),
    ...(agentName === undefined || agentName === '' ? {} : { agentName }),
    flushTelemetry: async () => {
      await Promise.all([tracer?.forceFlush(), meter?.forceFlush()]);
    },
  };
}

/** Strands Agents on the Anthropic API, as a framework (ADR 0021, ADR 0023). */
export const framework: Framework<StrandsTypes> = {
  name: 'strands',
  prepare: () => strandsRunner(runnerContextFromEnvironment()),
  agentOptionsMiddleware: strandsAgentOptionsMiddleware,
};
