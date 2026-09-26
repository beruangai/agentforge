import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  TELEMETRY_VARIABLE,
  type TelemetryLevel,
  TelemetryLevelSchema,
} from '#core/telemetry.ts';

/** Where the base image installs the ADOT collector. */
const COLLECTOR_BINARY = '/usr/local/bin/aws-otel-collector';
const COLLECTOR_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
const COLLECTOR_HEALTH_URL = 'http://127.0.0.1:13133/';
const COLLECTOR_START_TIMEOUT_MILLISECONDS = 10_000;
/** AgentCore's own destination for OTLP logs, set in every runtime. */
const AGENTCORE_LOGS_HEADERS_VARIABLE = 'OTEL_EXPORTER_OTLP_LOGS_HEADERS';

/**
 * What the Claude CLI exports at each level (§REQ602). Every level exports
 * metrics and events to the collector, surfaces export errors on stderr,
 * and exports often, so little is lost when a container stops; per-session
 * metric series are left out, as each is billed.
 */
export function cliTelemetryEnvironment(
  level: TelemetryLevel,
): Record<string, string> {
  const atLeast = (floor: TelemetryLevel): boolean =>
    TelemetryLevelSchema.options.indexOf(level) >=
    TelemetryLevelSchema.options.indexOf(floor);
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR_OTLP_ENDPOINT,
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

/** The log group and stream AgentCore names for OTLP logs. */
export function agentCoreLogDestination(environment: NodeJS.ProcessEnv): {
  logGroup: string;
  logStream: string;
} {
  const headers = new Map(
    (environment[AGENTCORE_LOGS_HEADERS_VARIABLE] ?? '')
      .split(',')
      .map((pair) => pair.split('=', 2) as [string, string | undefined]),
  );
  const logGroup = headers.get('x-aws-log-group');
  const logStream = headers.get('x-aws-log-stream');
  if (!logGroup || !logStream) {
    throw new Error(
      `${AGENTCORE_LOGS_HEADERS_VARIABLE} names no log group and stream; telemetry runs only on AgentCore`,
    );
  }
  return { logGroup, logStream };
}

export interface Telemetry {
  /** Stops the collector, which flushes what it holds; after the tasks stop. */
  stop(): Promise<void>;
}

/**
 * At the level the construct sets, starts the collector and points the CLI
 * of every task at it, through the environment tasks inherit. Nothing set,
 * nothing started — locally there is no role to sign with. A collector that
 * does not come up fails the request that prepared the container.
 */
export async function startTelemetry(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Telemetry | undefined> {
  const declared = environment[TELEMETRY_VARIABLE];
  if (declared === undefined || declared === '') return undefined;
  const level = TelemetryLevelSchema.parse(declared);
  const region = environment.AWS_REGION;
  if (!region) throw new Error('AWS_REGION must be set for telemetry');
  const { logGroup, logStream } = agentCoreLogDestination(environment);

  const configs = [
    'collector.yaml',
    ...(level === 'WARN' ? ['warn.yaml'] : []),
  ].map(
    (name) =>
      `--config=${fileURLToPath(new URL(`./collector/${name}`, import.meta.url))}`,
  );
  const collector = spawn(COLLECTOR_BINARY, configs, {
    env: {
      ...environment,
      AGENTFORGE_OTEL_LOG_GROUP: logGroup,
      AGENTFORGE_OTEL_LOG_STREAM: logStream,
      // ADOT logs to stderr, not to a file under /opt/aws it cannot create.
      RUN_IN_CONTAINER: 'True',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitUntilHealthy(collector);
  Object.assign(environment, cliTelemetryEnvironment(level));
  console.log(
    JSON.stringify({ event: 'agentforge.telemetry', level, logGroup }),
  );

  return {
    async stop() {
      if (collector.exitCode !== null) {
        throw new Error(`the collector had exited: ${collector.exitCode}`);
      }
      const exited = once(collector, 'exit');
      collector.kill('SIGTERM');
      await exited;
    },
  };
}

async function waitUntilHealthy(collector: ChildProcess): Promise<void> {
  let exit: string | undefined;
  collector.once('exit', (code, signal) => {
    exit = `exited ${code ?? signal}`;
  });
  collector.once('error', (error) => {
    exit = `failed to start: ${error.message}`;
  });
  const deadline = Date.now() + COLLECTOR_START_TIMEOUT_MILLISECONDS;
  while (Date.now() < deadline) {
    if (exit !== undefined) throw new Error(`the collector ${exit}`);
    const healthy = await fetch(COLLECTOR_HEALTH_URL).then(
      (response) => response.ok,
      () => false,
    );
    if (healthy) return;
    await delay(200);
  }
  collector.kill('SIGKILL');
  throw new Error(
    `the collector was not healthy within ${COLLECTOR_START_TIMEOUT_MILLISECONDS} ms`,
  );
}
