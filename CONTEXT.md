# Niuma Session Context

Niuma is a local-first coding agent whose single binary owns both the Client
experience and the Server Worker that runs and records agent Sessions.

## Language

**Workspace**: The absolute project directory in which one or more Sessions
operate. _Avoid_: Project, repository

**Workspace Key**: The Claude-style, human-readable directory name produced by
flattening a Workspace path with `-`. _Avoid_: Workspace hash, project key

**Session**: One durable conversation and agent execution history scoped to
exactly one Workspace. _Avoid_: Thread, chat

**Session Journal**: The append-only JSONL file that is the complete durable
truth for one Session. _Avoid_: Event log, transcript

**Session State**: The current model, effort, lifecycle, title, and pending
approvals derived by folding a Session Journal. _Avoid_: Projection, database
row

**Resume**: Attaching a Client to a named Session in its current Workspace after
replaying that Session Journal. _Avoid_: Global restore

**Model Call**: One provider sampling operation performed for an agent iteration
or compaction. _Avoid_: Completion, request

**Usage Record**: The content-free token, timing, provider, model, and outcome
facts for one Model Call. _Avoid_: Billing row, usage projection

**Usage Archive**: The content-free JSONL file retained after its Session
Journal is deleted. _Avoid_: Session archive, analytics database

**Retention**: The optional time-based policy that archives Usage Records before
deleting an expired Session Journal. _Avoid_: Compaction, garbage collection

## Relationships

- A **Workspace** owns zero or more **Sessions**
- A **Workspace Key** identifies exactly one **Workspace** directory
- A **Session** owns exactly one **Session Journal**
- A **Session Journal** folds into exactly one **Session State**
- A **Session** contains zero or more **Model Calls**
- A **Model Call** produces exactly one terminal **Usage Record**
- **Retention** produces one **Usage Archive** before deleting one expired
  **Session Journal**
- **Resume** reads one **Session Journal** from the current **Workspace**

## Example dialogue

> **Dev:** "Should Resume search every Workspace for this Session?" **Domain
> expert:** "No. Resume resolves the Session only inside the current Workspace
> Key and replays that Session Journal."

## Flagged ambiguities

- "Compaction" previously sounded like storage compaction; resolved: compaction
  only reduces model context and never shrinks a Session Journal.
- "Archive" means the content-free Usage Archive, not a retained conversation.
