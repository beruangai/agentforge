import type { ScaffoldedFile } from './artifacts/maintained.ts';

/** Where a layer's framework scaffolds go, and what their text names. */
export interface LayerScaffoldContext {
  /** The layer's directory: `<project>/base/agentic` or `<project>/agents/<agent>/agent`. */
  readonly directory: string;
  /** The project's own name: `golden-kata`. */
  readonly projectName: string;
  /** The base layer's package, by which agents import it. */
  readonly basePackageName: string;
}

/**
 * What the plugin renders for a framework's projects (ADR 0021), each
 * framework's `plugin/` part satisfying it, reached through
 * `src/framework/registry.ts`.
 */
export interface FrameworkPlugin {
  /** The base layer's scaffolds of the framework's own: its shared options and configuration. */
  baseScaffolds(context: LayerScaffoldContext): readonly ScaffoldedFile[];
  /** An agent layer's scaffolds of the framework's own: its configuration. */
  agentScaffolds(context: LayerScaffoldContext): readonly ScaffoldedFile[];
  /** The entries a project's generated code imports. */
  readonly imports: {
    /** `implementAgent` and `runTaskProcess`. */
    readonly agent: string;
    /** `framework`, for `startServer`. */
    readonly server: string;
    /** `REQUIRED_SECRETS`, for constructs. */
    readonly infra: string;
  };
  /** The packages the framework's code imports in the container, beside the shared peers: each a peer of AgentForge. */
  readonly containerPeers: readonly string[];
  /** The framework's image, from the installed package: its Dockerfile and its `container` build context. */
  readonly image: {
    readonly dockerfile: string;
    readonly containerDirectory: string;
  };
  /**
   * A layer's configuration directory, copied into the image where the
   * framework reads it: `$claude/` becomes `.claude/`.
   */
  readonly configurationDirectory: {
    readonly source: string;
    readonly target: string;
    /** What the directory is, as the base layer's and an agent's Dockerfile say it. */
    readonly purpose: { readonly base: string; readonly agent: string };
  };
  /** The secrets every agent of the framework requires. */
  readonly requiredSecrets: readonly string[];
}
