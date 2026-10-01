## Purpose
Turns documents a procedure has gathered into context for a run, within a token cap: passed through when they fit, otherwise distilled by a utility run of the procedure's own.

## ADDED Requirements

### Requirement: Documents within the cap pass through unchanged
A procedure SHALL be able to distill documents, each with a source and content, under a token cap. When their estimated token count is within the cap, distilling SHALL return each document as its own context block, unchanged and named by its source, and SHALL make no agent run.

#### Scenario: Documents that fit
- **WHEN** a procedure distills two documents whose estimated tokens are within the cap
- **THEN** it receives both, unchanged, each as a context block naming its source, and the task's record holds no run for them

### Requirement: Documents over the cap are distilled by one utility run
When the documents exceed the cap, distilling SHALL make one agent run of the procedure's own, with no tools and no capabilities beyond the model, asked to compact them for the procedure's stated purpose. The distillation SHALL cite what it keeps by source and line, and SHALL be returned as one context block. The utility run SHALL be recorded and cancelled with the task, as any run is.

#### Scenario: Documents that do not fit
- **WHEN** a procedure distills documents whose estimated tokens exceed the cap, with an instruction saying what the next run needs from them
- **THEN** it receives one context block holding the distillation, with citations by source and line, and the task's record holds the utility run

#### Scenario: Cancelled while distilling
- **WHEN** the task is cancelled during the utility run
- **THEN** the run stops and the task ends `TASK_STATE_CANCELED`

### Requirement: A distillation far over the cap fails
A distillation SHALL be allowed to run over the cap by up to half again. One longer than that SHALL fail the task with cause `OUTPUT_INVALID`, carrying the distillation; it SHALL NOT be passed on.

#### Scenario: Within the allowance
- **WHEN** a distillation runs a fifth over its cap
- **THEN** the procedure receives it

#### Scenario: Beyond the allowance
- **WHEN** a distillation runs to twice its cap
- **THEN** the task fails with cause `OUTPUT_INVALID`, carrying the distillation
