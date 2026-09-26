import { describe, expect, it } from 'vitest';
import {
  agentCoreLogDestination,
  cliTelemetryEnvironment,
  startTelemetry,
} from './telemetry.ts';

const AGENTCORE_LOGS_HEADERS =
  'x-aws-log-group=/aws/bedrock-agentcore/runtimes/agent-abc-DEFAULT,x-aws-log-stream=otel-rt-logs,x-aws-metric-namespace=bedrock-agentcore';

describe('cliTelemetryEnvironment', () => {
  it('exports metrics and events at WARN, and no traces or content', () => {
    const environment = cliTelemetryEnvironment('WARN');
    expect(environment).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      CLAUDE_CODE_OTEL_DIAG_STDERR: '1',
    });
    expect(environment.OTEL_TRACES_EXPORTER).toBeUndefined();
    expect(environment.OTEL_LOG_USER_PROMPTS).toBeUndefined();
  });

  it('adds traces at INFO, content at DEBUG and raw bodies at ALL', () => {
    expect(cliTelemetryEnvironment('INFO')).toMatchObject({
      OTEL_TRACES_EXPORTER: 'otlp',
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    });
    expect(
      cliTelemetryEnvironment('INFO').OTEL_LOG_TOOL_CONTENT,
    ).toBeUndefined();
    expect(cliTelemetryEnvironment('DEBUG')).toMatchObject({
      OTEL_LOG_USER_PROMPTS: '1',
      OTEL_LOG_TOOL_DETAILS: '1',
      OTEL_LOG_TOOL_CONTENT: '1',
    });
    expect(
      cliTelemetryEnvironment('DEBUG').OTEL_LOG_RAW_API_BODIES,
    ).toBeUndefined();
    expect(cliTelemetryEnvironment('ALL').OTEL_LOG_RAW_API_BODIES).toBe('1');
  });
});

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
    await expect(startTelemetry({})).resolves.toBeUndefined();
  });

  it('refuses a level it does not know', async () => {
    await expect(
      startTelemetry({ AGENTFORGE_TELEMETRY: 'VERBOSE' }),
    ).rejects.toThrow();
  });
});
