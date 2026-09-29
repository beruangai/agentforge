# Design

Nothing new is built: the spec states what the code does after the A4 fixes.

| Scenario | Covered by |
|---|---|
| A timed-out task pushes nothing | `src/server/harness/task-process.test.ts` "reports a cancel as cancelled" — the harness sees a timeout as a cancel; ⚠ no test drives a timeout through the executor to the unmount |
| Two filesystems at one directory | `src/server/harness/filesystem/registry.test.ts` "fail the task before anything mounts when two share a directory, or one is inside another" |
