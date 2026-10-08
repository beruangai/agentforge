// Asks before `destroy` empties the buckets and deletes the stage: the
// operator types the stage's name, so a stray click on the target, or
// `destroy` completed in place of `deploy`, deletes nothing. Without a
// terminal to ask on, it refuses.

import { createInterface } from 'node:readline/promises';

const stage = process.argv[2];
if (stage === undefined) {
  throw new Error('usage: confirm-destroy.ts <stage>');
}
if (!process.stdin.isTTY) {
  throw new Error(
    `destroy asks before deleting ${stage}, and there is no terminal to ask on; run it interactively`,
  );
}

const readline = createInterface({
  input: process.stdin,
  output: process.stdout,
});
// Ctrl+C or Ctrl+D aborts the question: that is a no, like any other answer.
const answer = await readline
  .question(
    `This empties ${stage}'s session bucket and deletes every stack in it. Type ${stage} to destroy it: `,
  )
  .catch(() => undefined);
readline.close();
if (answer?.trim() !== stage) {
  console.error(`\nNot destroyed: the answer was not ${stage}.`);
  process.exit(1);
}
