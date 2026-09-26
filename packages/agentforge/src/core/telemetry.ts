import { z } from 'zod';

/**
 * Set by the `AgentRuntime` construct and read by the server: how much of
 * the Claude CLI's telemetry an agent exports, as a log level (§REQ602).
 * `WARN` — metrics and error events; `INFO` — and every event and trace, no
 * content; `DEBUG` — and prompts, tool arguments and tool output; `ALL` — and
 * the raw API bodies.
 */
export const TELEMETRY_VARIABLE = 'AGENTFORGE_TELEMETRY';

export const TelemetryLevelSchema = z.enum(['WARN', 'INFO', 'DEBUG', 'ALL']);
export type TelemetryLevel = z.infer<typeof TelemetryLevelSchema>;
