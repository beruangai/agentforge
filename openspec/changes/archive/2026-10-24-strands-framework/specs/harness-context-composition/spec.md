## MODIFIED Requirements

### Requirement: Context is composed from typed context functions
A procedure SHALL be able to define a context function: a function of named input variables that returns prompt content — text, content blocks and tagged context blocks — synchronously or not. Composing several context functions SHALL yield one context function whose input is every input variable any of them needs, and whose output is each one's content, concatenated in the order they were given. A composed context function SHALL compose again like any other. Calling a context function without an input variable one of its parts needs, or with one of the wrong type, SHALL be a compile-time error. The content a context function returns SHALL be usable as a run's prompt and, in a `claude` run, as a command's context alike.

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
- **WHEN** a `claude` procedure places a composite's content as a command's context
- **THEN** the agent receives the command followed by that content, in order
