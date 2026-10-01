/**
 * Another task's process: claims a local directory, says so on stdout, then
 * holds it until killed, or exits without releasing it when told to.
 * Run as `bun claim-and-hold.ts <claims directory> <local path> <task id> hold|exit`.
 */
import { claimLocalDirectory } from '../mount-claims.ts';

const [directory, localPath, taskId, mode] = process.argv.slice(2);
if (
  directory === undefined ||
  localPath === undefined ||
  taskId === undefined
) {
  throw new Error(
    'usage: claim-and-hold <directory> <localPath> <taskId> hold|exit',
  );
}
await claimLocalDirectory({ name: 'held', taskId, localPath }, directory);
process.stdout.write('claimed\n');
if (mode === 'hold') setInterval(() => undefined, 60_000);
