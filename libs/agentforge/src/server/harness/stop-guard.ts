/** A check that must pass before the agent's structured output is accepted; the agent contract is always validated beside it. */
export type StopGuard = () => Promise<StopGuardDenial | undefined>;

export interface StopGuardDenial {
  /** Told to the agent, in its turn: what is wrong and what to do. */
  readonly reason: string;
}
