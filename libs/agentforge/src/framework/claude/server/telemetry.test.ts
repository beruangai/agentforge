import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TELEMETRY_LEVELS } from '#core/telemetry.ts';
import {
  CLAUDE_COLLECTOR_CONFIG,
  cliTelemetryEnvironment,
} from './telemetry.ts';

const ENDPOINT = 'http://127.0.0.1:4318';

describe('cliTelemetryEnvironment', () => {
  it('exports metrics and events at WARN, and no traces or content', () => {
    const environment = cliTelemetryEnvironment('WARN', ENDPOINT);
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
    expect(cliTelemetryEnvironment('INFO', ENDPOINT)).toMatchObject({
      OTEL_TRACES_EXPORTER: 'otlp',
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    });
    expect(
      cliTelemetryEnvironment('INFO', ENDPOINT).OTEL_LOG_TOOL_CONTENT,
    ).toBeUndefined();
    expect(cliTelemetryEnvironment('DEBUG', ENDPOINT)).toMatchObject({
      OTEL_LOG_USER_PROMPTS: '1',
      OTEL_LOG_TOOL_DETAILS: '1',
      OTEL_LOG_TOOL_CONTENT: '1',
    });
    expect(
      cliTelemetryEnvironment('DEBUG', ENDPOINT).OTEL_LOG_RAW_API_BODIES,
    ).toBeUndefined();
    expect(
      cliTelemetryEnvironment('ALL', ENDPOINT).OTEL_LOG_RAW_API_BODIES,
    ).toBe('1');
  });
});

describe('the collector configuration', () => {
  it('adds the WARN filter at WARN alone, every file beside the telemetry', () => {
    expect(
      CLAUDE_COLLECTOR_CONFIG.WARN.map((url) => url.pathname.split('/').pop()),
    ).toEqual(['collector.yaml', 'warn.yaml']);
    for (const level of TELEMETRY_LEVELS) {
      if (level !== 'WARN') {
        expect(
          CLAUDE_COLLECTOR_CONFIG[level].map((url) =>
            url.pathname.split('/').pop(),
          ),
        ).toEqual(['collector.yaml']);
      }
      for (const url of CLAUDE_COLLECTOR_CONFIG[level]) {
        expect(existsSync(fileURLToPath(url))).toBe(true);
      }
    }
  });
});
