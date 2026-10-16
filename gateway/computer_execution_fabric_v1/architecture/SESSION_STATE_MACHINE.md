# Session State Machine R1

## Nominal

```text
OPEN -> ACTIVE -> RUNNING <-> WAITING_INPUT
                    |
                    +-> IDLE
ACTIVE/RUNNING/WAITING_INPUT/IDLE -> CLOSING -> CLOSED
RUNNING -> EXITED -> CLOSING -> CLOSED
```

Adapter-specific prompt detection may emit `WAITING_INPUT`. Adapters that cannot prove prompt state remain `RUNNING/ACTIVE`; they must not invent readiness.

## Crash/restart

```text
ACTIVE/RUNNING/WAITING_INPUT/IDLE
        |
        v
    ORPHANED
        |
        v
   RECOVERING
     /     \
reattach   cannot reattach
   |             |
 ACTIVE        REAPING
                 |
        verified OS cleanup? ---- no ---> LOST
                 |
                yes
                 v
               CLOSED
```

A missing ConPTY/Job Object recovery binding produces `LOST`, not fake `CLOSED`. The binder may recover a semantic session on another host only by creating a new admitted session; it must never silently reinterpret that as byte-level PTY migration.

## Human control

```text
AGENT_CONTROL
  -> TAKEOVER_REQUESTED
  -> HUMAN_CONTROL
  -> RELEASED
  -> AGENT_CONTROL
```

Only the actor owning the control state may write normal input. Secret input additionally requires `HUMAN_CONTROL` and current fence validation.

## Session classes

- `EPHEMERAL`: short diagnostics/one-shot shell state. Resource GC after bounded idle.
- `PERSISTENT`: debugging/build/repl continuity. Snapshot/close after configured idle.
- `PINNED`: intentional server/debug console/deployment owner. No idle GC unless an explicit expiry exists.

TTL and idle timers are resource lifecycle controls only. They are not semantic Task/Farm timeouts.
