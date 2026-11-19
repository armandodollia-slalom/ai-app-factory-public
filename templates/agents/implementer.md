<!-- markdownlint-disable-file MD041 -->

<!-- Addendum skeleton. Copy to .factory/agents/implementer.md in your repository, fill it in, and delete this comment, the placeholder comments and any section that does not apply. The factory appends the file to the base definition under a "## Project context" heading, so start headings at level 3. See skills/write-agent-addenda. -->

### Stack

<!-- One or two sentences: languages, frameworks, how the services or modules talk to each other. Name the architecture docs to read before changing code. -->

### Shell setup

<!-- Anything a fresh shell or worktree needs: toolchain on PATH, environment variables, dependency install, how to build the knowledge graph if the repository uses graphify. -->

### Layout

<!-- Where product code, tests, generated files and deployment files live. -->

### Conventions: which example to follow

<!-- One row per concern: the existing file or module to copy. Remove rows that do not apply, add your own. -->

| Concern | Follow |
| --- | --- |
| New service or module | |
| Application wiring | |
| Auth | |
| Persistence and migrations | |
| Domain logic | |
| Events and messaging | |
| UI | |

### Rules

<!-- Stack-specific rules, one bullet each: where dependency versions are declared, the clock abstraction to inject, API versioning, how to create a migration, generated paths and the command that regenerates each, what registering a new service with the test stack takes. -->

### Planning subtasks

<!-- Shared files that must go in the first subtask that needs them (dependency manifests, wiring, shared config). -->

### Checks before you commit

<!-- Exact commands: build; unit tests of one service or module; lint and format, and their auto-fix variants. Say which checks must NOT be run here (slow suites, the shared test stack). -->
