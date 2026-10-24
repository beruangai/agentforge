import type {
  ContentBlock,
  ConversationManager,
  HookableEvent,
  HookableEventConstructor,
  HookCallback,
  HookCallbackOptions,
  InterventionHandler,
  InvokeLimits,
  McpClient,
  Plugin,
  ToolList,
  Usage,
} from '@strands-agents/sdk';
import type { AnthropicModelConfig } from '@strands-agents/sdk/models/anthropic';
import type {
  AgentRun as SharedAgentRun,
  AgentRunSpec as SharedAgentRunSpec,
  TaskContext as SharedTaskContext,
} from '../../../server/harness/framework.ts';

/**
 * One callback on one of the agent's events, which the runner registers with
 * `agent.addHook` before the run. Made with `hook()`, which checks the
 * callback against its event.
 */
export interface StrandsHook {
  readonly event: HookableEventConstructor;
  readonly callback: HookCallback<HookableEvent>;
  readonly options?: HookCallbackOptions;
}

/** The options a `strands` procedure may set; the runner owns the rest. */
export interface StrandsOptions {
  /** The Anthropic model id, such as `claude-sonnet-5-5`. */
  readonly model?: string;
  readonly maxTokens?: number;
  /**
   * The provider's other settings: temperature, `params` such as thinking,
   * betas. A run's cache points are AgentForge's, from its context blocks'
   * cache breakpoints, so the provider's own `cacheConfig` is not taken.
   */
  readonly modelConfig?: Omit<
    AnthropicModelConfig,
    'modelId' | 'maxTokens' | 'cacheConfig'
  >;
  /** The procedure's own system prompt; the layers' instructions and AgentForge's fragments follow it. */
  readonly systemPrompt?: string;
  readonly tools?: ToolList;
  /** MCP servers by name. Each must start, or the run fails before its first turn (§REQ201). */
  readonly mcpClients?: Readonly<Record<string, McpClient>>;
  readonly plugins?: readonly Plugin[];
  /** Callbacks on the agent's events, registered after AgentForge's own; they accumulate across parts. */
  readonly hooks?: readonly StrandsHook[];
  readonly interventions?: readonly InterventionHandler[];
  readonly conversationManager?: ConversationManager;
  /** Directories the agent works in, named in its system prompt: a procedure's mounts, from `context.agentOptions`. */
  readonly workingDirectories?: readonly string[];
  /** Whether the layers' instructions and skills compose into the run; `false` for a utility run. On by default. */
  readonly layers?: boolean;
  /** The run's own limits; reaching one is `BUDGET_EXHAUSTED`. */
  readonly limits?: InvokeLimits;
}

/** What the `strands` framework fixes for its procedures' types. */
export type StrandsTypes = {
  readonly content: ContentBlock;
  readonly options: StrandsOptions;
  readonly extras: {
    /**
     * One space of the agent's memory, kept in its storage under its name and
     * recalled by a later run that declares the same space (§REQ404). Without
     * it, the run keeps no memory.
     */
    readonly memorySpace?: string;
    /** How many structured outputs the agent may submit before the run fails; five by default (§REQ208). */
    readonly maxStructuredOutputAttempts?: number;
    /** The session id of an earlier run of this agent, to resume (§REQ402). */
    readonly resume?: string;
    /**
     * Tool results over `maxResultTokens` kept in the agent's storage, a
     * preview in context and the rest retrieved on demand. Off unless declared.
     */
    readonly offload?: {
      readonly maxResultTokens: number;
      readonly previewTokens?: number;
    };
  };
  /** The SDK's accumulated usage. */
  readonly usage: Usage;
};

export type AgentRunSpec<Output> = SharedAgentRunSpec<StrandsTypes, Output>;

export type AgentRun<Output> = SharedAgentRun<StrandsTypes, Output>;

/**
 * What every `strands` procedure handler receives as its oRPC context. An
 * interface rather than an alias, so a procedure module's inferred router
 * type names it from `/strands/agent`.
 */
export interface TaskContext extends SharedTaskContext<StrandsTypes> {}
