import { z } from 'zod';

/** Every framework this AgentForge provides, by its name in a project's record and a run's (ADR 0021). */
export const FRAMEWORK_NAMES = ['claude', 'strands'] as const;
export const FrameworkNameEnum = z.enum(FRAMEWORK_NAMES);
export type FrameworkName = z.infer<typeof FrameworkNameEnum>;
