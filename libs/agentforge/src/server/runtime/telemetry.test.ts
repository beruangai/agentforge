import { describe, expect, it } from 'vitest';
import { agentCoreLogDestination, startTelemetry } from './telemetry.ts';

/** A framework whose tasks export nothing; the collector never starts in these tests. */
const FRAMEWORK = {
  telemetryEnvironment: () => ({}),
  collectorConfig: { WARN: [], INFO: [], DEBUG: [], ALL: [] },
};

const AGENTCORE_LOGS_HEADERS =
  'x-aws-log-group=/aws/bedrock-agentcore/runtimes/agent-abc-DEFAULT,x-aws-log-stream=otel-rt-logs,x-aws-metric-namespace=bedrock-agentcore';

describe('agentCoreLogDestination', () => {
  it('reads the log group and stream AgentCore names for OTLP logs', () => {
    expect(
      agentCoreLogDestination({
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: AGENTCORE_LOGS_HEADERS,
      }),
    ).toEqual({
      logGroup: '/aws/bedrock-agentcore/runtimes/agent-abc-DEFAULT',
      logStream: 'otel-rt-logs',
    });
  });

  it('refuses to run anywhere AgentCore has not named them', () => {
    expect(() => agentCoreLogDestination({})).toThrow(/only on AgentCore/);
  });
});

describe('startTelemetry', () => {
  it('starts nothing when no level is set', async () => {
    await expect(
      startTelemetry({ agentName: 'agent', framework: FRAMEWORK }, {}),
    ).resolves.toBeUndefined();
  });

  it('refuses a level it does not know', async () => {
    await expect(
      startTelemetry(
        {
          agentName: 'agent',
          runtimeSessionId: 'session',
          framework: FRAMEWORK,
        },
        { AGENTFORGE_TELEMETRY: 'VERBOSE' },
      ),
    ).rejects.toThrow();
  });

  it('refuses to start without the runtime session to stamp on its spans', async () => {
    await expect(
      startTelemetry(
        { agentName: 'agent', framework: FRAMEWORK },
        {
          AGENTFORGE_TELEMETRY: 'INFO',
          AWS_REGION: 'us-east-2',
        },
      ),
    ).rejects.toThrow(/runtime session/);
  });
});
