import type { Framework } from '../../../server/harness/framework.ts';

/** A Strands content block, as a placeholder until `strands-framework` defines it. */
interface StrandsContentBlock {
  readonly type: 'strands-content';
  readonly text: string;
}

/** A Strands run's options, as a placeholder until `strands-framework` defines them. */
interface StrandsOptions {
  readonly model?: string;
  readonly maxTokens?: number;
}

/** A Strands run's usage, as a placeholder until `strands-framework` defines it. */
interface StrandsUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** What the `strands` framework would fix for its procedures' types. */
export type StrandsTypes = {
  readonly content: StrandsContentBlock;
  readonly options: StrandsOptions;
  readonly extras: { readonly sessionManager?: string };
  readonly usage: StrandsUsage;
};

function notImplemented(): never {
  throw new Error('the strands framework is not implemented');
}

/**
 * A typechecked shell of Strands Agents as a framework, so the interface is
 * not shaped by `claude` alone (ADR 0021). It is in no registry, export or
 * bundle entry; `strands-framework` implements it.
 */
export const strands: Framework<StrandsTypes> = {
  name: 'strands',
  prepare: notImplemented,
  get agentOptionsMiddleware(): Framework<StrandsTypes>['agentOptionsMiddleware'] {
    return notImplemented();
  },
};
