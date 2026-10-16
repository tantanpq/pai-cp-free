# Security and Authority Boundary R1

## Principle

The execution engine is broad; authorization is external and mandatory. Capability breadth must not be implemented as an allowlist of a few commands, but no interactive byte may reach the shell without current ownership and operation admission.

`SessionRuntime` therefore requires two injected controls:

```text
fenceValidator(metadata, suppliedFence)
operationAuthorizer(session, metadata, operation)
```

A binder that omits either dependency cannot instantiate the runtime. This prevents an accidentally powerful but ungoverned shell from appearing merely because someone managed to import a module before coffee.

## Required policy facts

The live `operationAuthorizer` should evaluate at least:

- admitted root/request/task identity;
- current Claim/fence ownership;
- effect class and reversible/destructive/public/credential boundary;
- allowed filesystem roots;
- network policy;
- service/process mutation scope;
- session actor/control state;
- host identity and current capability eligibility.

## Secret path

Secret values never belong in normal `SESSION_INPUT`. The secure path is:

```text
PTY -> SECRET_INPUT_REQUIRED
viewer/user -> secret channel -> adapter
model -> only completion marker
```

The reference also redacts terminal echo of a recently submitted secret before that output reaches RAM ring, disk spool or actor transcript. A live binder should additionally disable PTY echo when the underlying prompt/protocol supports it.

## Fail-closed invariants

- stale fence -> reject input;
- missing host authority/Host Control eligibility -> host not selectable;
- missing OS orphan reaper -> crash state becomes `LOST`, not fake clean;
- missing process-tree verification -> close is `CLOSED_CLEANUP_UNVERIFIED`;
- force terminate requires an explicitly admitted force effect;
- session engine never mints authority or semantic DONE.
