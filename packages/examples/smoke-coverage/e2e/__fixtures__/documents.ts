/**
 * Documents for `DistillThenAnswer`: a lighthouse's logbooks, one fact the
 * question needs buried among entries it does not, and a cap small enough
 * that the logbooks must be distilled — or large enough that they pass whole.
 */
const WEATHER = ['calm', 'squally', 'foggy', 'clear', 'gale from the west'];

function logbook(season: string, fact: string): string {
  const entries = Array.from(
    { length: 30 },
    (_, day) =>
      `${season}, day ${day + 1}: lamp lit at ${18 + (day % 3)}:00, ${WEATHER[day % WEATHER.length]}, ${day % 4} ships passed, oil at ${90 - day} gallons.`,
  );
  entries.splice(17, 0, fact);
  return entries.join('\n');
}

export const QUESTION = 'What is the name of the keeper’s cat?';
export const ANSWER = /Bramblewick/i;

/** About 2 000 tokens: over a cap of 400, so distilled in a run of its own. */
export const LOGBOOKS = [
  {
    source: 'logbooks/spring.md',
    content: logbook('Spring', 'Spring: the keeper took in a stray cat.'),
  },
  {
    source: 'logbooks/summer.md',
    content: logbook(
      'Summer',
      'Summer: the keeper named the cat Bramblewick, after the bramble it hid in.',
    ),
  },
  {
    source: 'logbooks/autumn.md',
    content: logbook('Autumn', 'Autumn: a new lens was fitted to the lamp.'),
  },
];
export const SMALL_CAP_TOKENS = 400;

/** One entry: within the default cap, so passed whole. */
export const NOTE = [
  {
    source: 'logbooks/note.md',
    content:
      'Summer: the keeper named the cat Bramblewick, after the bramble it hid in.',
  },
];
export const LARGE_CAP_TOKENS = 12_000;
