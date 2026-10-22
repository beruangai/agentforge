import { z } from 'zod';

/**
 * Set by the `AgentRuntime` construct and read by the server: how much
 * telemetry an agent's runs export, as a log level (§REQ602). `WARN` —
 * metrics and error events; `INFO` — and every event and trace, no content;
 * `DEBUG` — and prompts, tool arguments and tool output; `ALL` — and the raw
 * API bodies. Each framework maps the level onto its SDK's own export.
 */
export const TELEMETRY_VARIABLE = 'AGENTFORGE_TELEMETRY';

export const TELEMETRY_LEVELS = ['WARN', 'INFO', 'DEBUG', 'ALL'] as const;
export const TelemetryLevelEnum = z.enum(TELEMETRY_LEVELS);
export type TelemetryLevel = z.infer<typeof TelemetryLevelEnum>;
