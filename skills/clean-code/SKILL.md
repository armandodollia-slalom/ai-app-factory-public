---
name: clean-code
description: "The clean-code rules every agent that writes code or tests follows, with examples in this repository's languages. USE FOR: \"clean code\", \"is this duplicated\", \"where does this value live\", writing or reviewing code, planning where a change goes. Rule ids are `CC-<n>`; a clean-code finding cites one."
---

# Clean code

Rules for code and tests that stay easy to change: one home for every value, no copied logic, clear names, small
functions, honest comments, no dead code and tests that catch bugs. Each rule has an id of the form `CC-<n>`, and a
clean-code finding cites the rule it breaks by that id. (Business rules, `RULE-<n>`, are a different set kept
elsewhere; these are only about how code is written.)

The structure is adapted from [ertugrul-dmr/clean-code-skills](https://github.com/ertugrul-dmr/clean-code-skills)
(MIT). Its boy-scout rule (improve something on every touch) and its rule to keep trivial tests are left out: they
contradict the scope rule and the useless-tests rule below.

## Who reads what

- **Orchestrators** (the implement orchestrator, and every stage orchestrator that hands work to a writer) know all of
  these rules. Before handing out work they search the codebase for the sources of truth, constants, helpers and
  copies the work touches, and write concrete guidance into each writer's task: where the change goes, what to reuse
  (file and line), and what must not be redefined.
- **Writing agents** (implementers, the test automation agent, the PR check fixer) carry a short core: the scope rule,
  the guidance rule, and a small set of these rules chosen from what their past work got wrong. The pipeline gives
  them that set; they are not given all of the rules.
- **The clean-code reviewer** knows all of these rules and is the strict arbiter: it searches the codebase itself,
  checks that the orchestrator's guidance was followed, and treats every upheld breach as blocking.

## Search before you add

Never guess whether a constant, setting default, message, helper or behaviour already exists: search.

1. graphify finds where things live: `graphify query "<question>"`, `graphify explain "<symbol>"`,
   `graphify path "<A>" "<B>"`.
2. The language-server tools confirm it: `lsp_workspace_symbols` for a name, `lsp_goto_definition` for the one
   authoritative definition, `lsp_find_references` for every caller.
3. Only then add something, and only when nothing found does the job.

The harness records these calls; a review checks that they were made for every value and helper a change adds.

## The scope rule

### SCOPE Change only what your task owns

Clean what you change, inside the files your task owns. A problem you notice outside them is a follow-up (report it),
never a drive-by change. This rule is not a clean-code rule and is never taken out of a writer's rules.

## The writer core

Every writing agent follows these, whatever else its rules say:

- **Scope:** the `SCOPE` rule.
- **Guidance:** your task may say where a change goes, what to reuse (file and line) and what must not be redefined.
  Reuse what it names. Never write a second definition of a value, helper or behaviour that already has a source:
  read it from that source.
- **Search:** follow the *Search before you add* steps before you add a constant, default, message or helper.

## One source of truth

### CC-1 Every value has one home

Every constant, setting default, message and business rule has one authoritative place. Code reads it from there and
never repeats its value as a fallback or a literal: no `?? 900` beside a default file that already says 900, no
copied message text, no second list of the same allowed values. When the source cannot be reached from where you
are, pass the value in; do not copy it.

## Duplication

### CC-2 No copied logic

No logic copied across files or across branches of one function. Extract the shared part when the copies describe
the same knowledge (they would always change together). Leave them apart when they only look alike but change for
different reasons: extracting them couples two things that should move independently.

## Names

### CC-3 Names say what a thing is or does

A name says what a value holds or what a function does, in the words of the domain. No abbreviations a reader must
decode, no names that lie about what the code does, no generic `data`, `info`, `manager` or `helper` where a
specific word exists.

### CC-4 One word per concept

Use one word for one concept across the codebase (not `fetch`, `get` and `load` for the same operation), and the
word the codebase already uses for it.

## Functions

### CC-5 One job per function

A function does one thing at one level of abstraction. When describing it needs "and", or its body mixes high-level
steps with low-level detail, split it.

### CC-6 Few parameters

Few parameters. Group values that travel together into one object; do not pass values a function can read from a
source it already has.

### CC-7 No flag that switches behaviour

No boolean parameter that makes a function do one of two different things. Write two functions, or pass the
behaviour itself.

## Comments

### CC-8 Comments say why

A comment says why the code is the way it is (a constraint, a decision, a trap), not what the next line does. No
comment that repeats the code, and none that names a ticket instead of the reason.

### CC-9 No commented-out code

No commented-out code. Version control keeps old code.

## Dead code

### CC-10 No dead code

No unused functions, exports, imports, variables, parameters, files or settings. Delete what nothing uses in the
lines you change; report the rest as a follow-up.

## Tests

### CC-11 Test behaviour, not implementation

A test checks what the code does through its public surface, so a refactor that keeps the behaviour keeps the test
green.

### CC-12 One behaviour per test

A test checks one behaviour. Several assertions about that behaviour are fine; a second behaviour gets its own test.

### CC-13 Cover boundaries and error paths

Tests cover the boundaries (empty, one, the limit, one past it) and the error paths, not only the happy path.

### CC-14 No useless tests

A test is useless when deleting it would let no plausible bug through:

<!-- include: council "Useless tests" list -->
- it asserts what the compiler, the framework or a mock already guarantees;
- it repeats another test with different literals and no new branch;
- it tests a getter, a constructor or a constant;
- it mocks the thing under test, so it only checks the mock;
- it restates the implementation line by line and breaks on any refactor.
<!-- end include -->

Delete such a test, or do not write it. Keep a test that is the only cover for an acceptance line or an error path,
a regression test kept for an upheld finding, and another story's tests.

## Examples

The examples for this repository's languages follow when the factory installs this skill (each language pack's
`clean-code.md`).
