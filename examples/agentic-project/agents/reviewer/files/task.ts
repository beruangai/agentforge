// The task entry: the one place the harness and this agent's procedures meet.
import { runTaskProcess } from '@beruangai/agentforge/agent';
import { reviewer } from './contract.ts';
import { router } from './procedures.ts';

runTaskProcess({ contract: reviewer, router });
