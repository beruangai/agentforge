// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
//
// The task entry: the one place the harness and this agent's procedures meet.
import { runTaskProcess } from '@beruangai/agentforge/agent';
import { contract } from './contract.ts';
import { router } from './procedures.ts';

runTaskProcess({ contract, router });
