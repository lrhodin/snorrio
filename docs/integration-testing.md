# Integration Testing

These are executable instructions for agents testing Snorrio in its real harness. Tests are Markdown; evidence, not a framework's green badge, determines the result. They complement the repository's automated tests.

## Procedure

1. Start an execution agent with the test's **Assignment**, without the suspected bug, expected tool sequence, acceptance checks, or your verdict. It should discover and use the installed skills normally. Run in disposable resources; protect unrelated work.
2. Collect actual calls, results, process/pane identities, lifecycle notifications, and cleanup evidence. A final claim alone is not a pass. Let asynchronous completion arrive normally; do not poll session logs.
3. Give a separate review agent the assignment, execution evidence, relevant skill diff, and implementation where needed. It must independently judge the acceptance checks, separate product behavior from harness bookkeeping, and state evidence limitations. It must not edit the implementation under review.
4. Report pass, partial, fail, or blocked with evidence. If guidance needs correction, replace misleading wording rather than accumulating instructions. Repeat execution and independent review after any change: the previous run does not validate the new wording.
5. Record the tested revision or exact working-tree diff, installed harness version, execution/review session references, outcome, and residual issues in the tracking issue or PR. Keep credentials and private transcripts out of this repository. Commit reusable test definitions, not machine-specific logs.

## Tests

### IT-001 — Interrupt, redirect, finish, and clean up a helper

**Prerequisites:** Pi inside Herdr, current Snorrio skills and subagent extension, permission to create and close disposable helper terminals. No audio or other project mutation is needed.

**Assignment** (give only this block to the execution agent):

> Use the applicable installed skills to run a harmless live coordination exercise. Create one interactive helper for a small disposable task, interrupt it mid-task, then change its assignment using its existing conversation context. Obtain the revised result, finalize the helper, and clean up its terminal. Do not touch other agents' tabs, audio, project source, or skills. Report the actual tool calls, IDs, results, lifecycle notifications, and remaining helper terminals. Perform the exercise rather than describing a plan.

**Acceptance checks** (for the independent reviewer):

- One helper process is created. Interrupt ends its current turn, not its process or pane.
- The revised assignment is sent to that same live helper; no second process writes to the same transcript and no duplicate revised execution occurs.
- The revised result is actually read and correct for the disposable input.
- An interactive helper publishes its completion through the supported child completion handshake before external cleanup. Herdr `done` or visible output alone is not proof that the parent received completion.
- The parent receives a successful completion result, not a pane-disappeared failure; no unnecessary retry follows cleanup.
- Only test-owned helper terminals are closed, with no leftovers or interference with pre-existing panes.
- Claims about process identity and cleanup use live IDs/results, not matching transcript paths or tab labels alone.

**Review notes:** Inspect the installed completion implementation when notifications disagree with visible output. Do not assume that waiting longer fixes a missing completion handshake. Mark execution success and bookkeeping failure separately. If the reviewer uses session-level recall rather than direct execution artifacts, state that limitation.
