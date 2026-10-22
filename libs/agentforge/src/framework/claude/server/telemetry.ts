import { type TelemetryLevel, TelemetryLevelEnum } from '#core/telemetry.ts';

/**
 * What the Claude CLI exports at each level (§REQ602). Every level exports
 * metrics and events to the collector, surfaces export errors on stderr,
 * and exports often, so little is lost when a container stops; per-session
 * metric series are left out, as each is billed.
 */
export function cliTelemetryEnvironment(
  level: TelemetryLevel,
  collectorEndpoint: string,
): Record<string, string> {
  const atLeast = (floor: TelemetryLevel): boolean =>
    TelemetryLevelEnum.options.indexOf(level) >=
    TelemetryLevelEnum.options.indexOf(floor);
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: collectorEndpoint,
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
    OTEL_LOGS_EXPORT_INTERVAL: '1000',
    OTEL_TRACES_EXPORT_INTERVAL: '1000',
    OTEL_METRICS_INCLUDE_SESSION_ID: 'false',
    CLAUDE_CODE_OTEL_DIAG_STDERR: '1',
    ...(atLeast('INFO') && {
      OTEL_TRACES_EXPORTER: 'otlp',
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    }),
    ...(atLeast('DEBUG') && {
      OTEL_LOG_USER_PROMPTS: '1',
      OTEL_LOG_TOOL_DETAILS: '1',
      OTEL_LOG_TOOL_CONTENT: '1',
    }),
    ...(atLeast('ALL') && { OTEL_LOG_RAW_API_BODIES: '1' }),
  };
}

const collector = (name: string): URL =>
  new URL(`./collector/${name}`, import.meta.url);

/** The collector's configuration at each level: `WARN` keeps only error events. */
export const CLAUDE_COLLECTOR_CONFIG: Readonly<
  Record<TelemetryLevel, readonly URL[]>
> = {
  WARN: [collector('collector.yaml'), collector('warn.yaml')],
  INFO: [collector('collector.yaml')],
  DEBUG: [collector('collector.yaml')],
  ALL: [collector('collector.yaml')],
};
