---
status: accepted
---

# Use workspace-scoped JSONL as the only Session truth

## Context

Niuma is primarily one binary containing a Client and a Server Worker. The former
global Session directory plus SQLite read model duplicated durability, made the
rebuild contract fail, and did work at startup that the default "start a new
Session" path does not need. Cross-Workspace discovery also does not match how a
person resumes coding work: they first enter a Workspace, then choose one of
that Workspace's Sessions.

Long-term token and model analytics still need to survive after conversation
content is removed. That need does not require an operational database or
permanent prompt/tool/response retention.

## Decision

Niuma keeps one append-only Session Journal per Session under a Claude-style
Workspace Key and removes SQLite from Session persistence. Resume is explicitly
limited to the current Workspace and is lazy; startup does not enumerate
Sessions. Optional time-based Retention first extracts content-free Usage
Records into a long-lived Usage Archive and only then deletes the Session
Journal. Compaction changes model context but never rewrites storage. A future
analytics database may be added only as a disposable cache rebuildable from live
Session Journals and Usage Archives.

The concrete layout is:

```text
~/.niuma/
├── sessions/
│   └── -Users-arias-Projects-example/
│       ├── workspace.json
│       └── <session-id>.jsonl
└── usage/
    └── -Users-arias-Projects-example/
        └── <session-id>.jsonl
```

The Workspace Key is the normalized absolute path with path separators flattened
to `-`; it is never hashed. `workspace.json` binds that readable key to the
exact absolute path. A collision fails visibly instead of mixing data or adding
a hidden hash suffix.

`SessionStore` assigns sequence/timestamp metadata and fsyncs each append.
Replay validates every complete line, discards only an incomplete final append,
and deletes a structurally corrupt Journal. `SessionState` is a pure fold over
one Journal. Model and effort changes, lifecycle, pending approvals, and every
terminal Model Call are events.

`--resume <session-id>` and TUI `/resume [id]` are explicit. A bare `/resume`
folds only a small recent set for display; prefix resolution enumerates
filenames and opens only the resolved Journal. Default CLI/TUI startup creates a
new Session without listing Session files.

The optional top-level `session_retention_days` setting is the only cleanup
policy. When absent, Retention is disabled. When enabled, a silent background
sweep considers only Journal mtime in the current Workspace. For each expired,
inactive Session it:

1. extracts strict, content-free Usage Records;
2. writes and fsyncs a same-directory temporary Usage Archive;
3. atomically renames and reads the archive back;
4. rechecks activity and Journal age;
5. deletes the Journal.

An archive conflict/write/verification failure always keeps the Journal. Usage
Archives have no automatic expiry. Re-archiving is idempotent; an existing
Archive may be extended only when its records are an exact prefix of the current
Journal's Usage Records. Any rewritten history is a conflict. A structurally
corrupt derived Archive is deleted and rebuilt while the complete Journal is
still present.

## Consequences

- Model, effort, lifecycle, approvals, and Model Call usage must be expressed as
  recorded events so Session State is fully rebuildable.
- Missing provider usage is `null`, not a fabricated zero. Reasoning and cache
  token fields are retained when reported.
- Compaction appends a summary event and changes only future model context; it
  never rewrites or shrinks the Journal.
- `serve` remains a debugging entrypoint for one Workspace; remote and
  cross-Workspace Clients require a separate future decision.
- The unreleased project ships no reader or migration path for the former flat
  Session directory or `niuma.db`.

## Rejected alternatives

- Keep SQLite as an operational read model: rejected because it duplicates
  durability and reintroduces a rebuild invariant into the Session hot path.
- Use global or cross-Workspace Resume: rejected because it does not match the
  Workspace-first interaction model.
- Hash Workspace paths: rejected because readable directories are easier for
  users to inspect and manage manually.
- Shrink Journals during compaction: rejected because model-context management
  and durable history retention are separate concerns.
