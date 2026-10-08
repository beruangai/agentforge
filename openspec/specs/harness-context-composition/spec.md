# harness-context-composition Specification

## Purpose
Lets a procedure build its agent's context from reusable, typed pieces — static content read from files and dynamic content from the procedure's inputs — composed into one function the procedure calls, instead of assembling each prompt by hand.

## Requirements

### Requirement: Context is composed from typed context functions
A procedure SHALL be able to define a context function: a function of named input variables that returns prompt content — text, content blocks and tagged context blocks — synchronously or not. Composing several context functions SHALL yield one context function whose input is every input variable any of them needs, and whose output is each one's content, concatenated in the order they were given. A composed context function SHALL compose again like any other. Calling a context function without an input variable one of its parts needs, or with one of the wrong type, SHALL be a compile-time error. The content a context function returns SHALL be usable as a run's prompt and as a command's context alike.

#### Scenario: A composite keeps its parts' order
- **WHEN** a procedure composes a function returning static protocol blocks, a function of `directory` and a function of `topic`, and calls the composite with a directory and a topic
- **THEN** it receives the protocol blocks, then the directory's content, then the topic's content, in that order

#### Scenario: Composites nest
- **WHEN** a composite is composed with another context function
- **THEN** the result needs the inputs of every function inside either, and returns their content in order

#### Scenario: A missing input does not compile
- **WHEN** a procedure calls a composite without one of the input variables a composed function needs
- **THEN** the procedure fails to compile, naming the missing variable

#### Scenario: Composed content under a command
- **WHEN** a procedure places a composite's content as a command's context
- **THEN** the agent receives the command followed by that content, in order

### Requirement: A context block can carry a file's content
A tagged context block SHALL be able to name a file instead of carrying its text, and SHALL then render exactly as the same block with the file's content inline. The file SHALL be read when the run starts, resolved against the run's working directory when it is not absolute, wherever the block appears in the prompt, including in a command's context. A block that names a file which cannot be read SHALL fail the run before the agent starts, naming the file. A block that carries both text and a file, or neither, SHALL fail the run the same way.

#### Scenario: A protocol fragment from a file
- **WHEN** a run's prompt holds a context block tagged `protocol` with the attribute `name="dates"` that names `../.claude/fragments/dates.md` relative to its working directory
- **THEN** the agent receives a `protocol` block with that attribute, holding the file's content, and the file's path is not among its attributes

#### Scenario: A file that cannot be read
- **WHEN** a run's prompt holds a context block naming a file that does not exist
- **THEN** the run fails before the agent starts, naming the file
