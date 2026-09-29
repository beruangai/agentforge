import {
  Artifact,
  type Message,
  type Task,
  taskStateFromJSON,
  taskStateToJSON,
} from '@a2a-js/sdk';
import { type Envelope, EnvelopeSchema } from '#core/contract/envelope.ts';
import {
  OUTCOME_ARTIFACT_ID,
  type Outcome,
  outcomeOfArtifacts,
  type TaskState,
  TaskStateEnum,
} from '#core/contract/task.ts';

export function stateOf(task: Task): TaskState {
  const state = task.status?.state;
  if (state === undefined) throw new Error(`task ${task.id} has no status`);
  return TaskStateEnum.parse(taskStateToJSON(state));
}

export function newTask(options: {
  id: string;
  contextId: string;
  state: TaskState;
  metadata: Record<string, unknown>;
}): Task {
  return {
    id: options.id,
    contextId: options.contextId,
    status: {
      state: taskStateFromJSON(options.state),
      message: undefined,
      timestamp: new Date().toISOString(),
    },
    artifacts: [],
    history: [],
    metadata: options.metadata,
  };
}

/** The task as it ended: its state follows the outcome, which rides as the artifact. */
export function finishedTask(
  task: Task,
  outcome: Outcome,
  metadata: Record<string, unknown> = {},
): Task {
  const artifact: Artifact = {
    artifactId: OUTCOME_ARTIFACT_ID,
    name: 'outcome',
    description: 'How the task ended: its typed output, or why it failed',
    parts: [
      {
        content: { $case: 'data', value: outcome },
        metadata: undefined,
        filename: '',
        mediaType: 'application/json',
      },
    ],
    metadata: undefined,
    extensions: [],
  };
  return {
    ...task,
    status: {
      state: taskStateFromJSON(outcome.state),
      message: undefined,
      timestamp: new Date().toISOString(),
    },
    artifacts: [artifact],
    metadata: { ...task.metadata, ...metadata },
  };
}

export function outcomeOf(task: Task): Outcome | undefined {
  return outcomeOfArtifacts(
    task.artifacts.map((artifact) => Artifact.toJSON(artifact)),
  );
}

/**
 * The envelope, from the message's one data part. A part the SDK could not
 * decode arrives with its content stripped, so anything but exactly one data
 * part is refused rather than read as empty.
 */
export function readEnvelope(message: Message | undefined): Envelope {
  if (message === undefined) throw new Error('the request carries no message');
  const dataParts = message.parts.filter(
    (part) => part.content?.$case === 'data',
  );
  const [part] = dataParts;
  if (dataParts.length !== 1 || part?.content?.$case !== 'data') {
    throw new Error(
      `expected exactly one data part carrying the envelope, got ${dataParts.length} of ${message.parts.length} parts`,
    );
  }
  return EnvelopeSchema.parse(part.content.value);
}
