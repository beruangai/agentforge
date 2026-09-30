---
name: kata-style
description: What makes a good coding kata — use when writing, reviewing or grading a kata's description, signature or cases.
---

A good kata:

- **Names one small task.** One pure function, solvable in under 30 lines; no I/O, randomness, dates or global state.
- **Is unambiguous.** The description states the input's constraints and what to return in every edge case the cases exercise. A solver never has to guess from the cases.
- **Has cases that teach.** Start with the simplest case, then the typical one, then edge cases: empty input, a single element, duplicates, negatives or boundaries where the task has them. No two cases test the same thing.
- **Fits its difficulty.** `EASY`: one loop or a direct formula. `MEDIUM`: a small data structure or two passes. `HARD`: an algorithm a solver must choose, such as dynamic programming or a graph search, with a case that punishes the naive approach only by its answer, never by its running time.
- **Uses plain JSON values.** Numbers, strings, booleans, arrays and objects; never `undefined`, `NaN`, `Infinity` or dates.
