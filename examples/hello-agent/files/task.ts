// The task entry: the one place the harness and this agent's procedures meet.
import { runTaskProcess } from '@beruangai/agentforge/agent';
import { helloAgent } from './contract.ts';
import { router } from './procedures.ts';

runTaskProcess({ contract: helloAgent, router });
