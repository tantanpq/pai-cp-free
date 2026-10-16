# Internal API Surface R1

These are internal Host Control primitives, not a requirement for separate public MCP tools.

| Primitive | Reference method | Meaning |
|---|---|---|
| `session.open` | `SessionRuntime.open` | create one governed persistent owner |
| `session.exec/send` | `SessionRuntime.input` | admitted interactive input |
| `session.observe` | `SessionRuntime.read` | bounded incremental output |
| `session.status` | `SessionRuntime.status` | current lifecycle/resource status |
| `session.snapshot` | `SessionRuntime.snapshot` | bounded semantic continuity state |
| `session.resize` | `SessionRuntime.resize` | PTY dimensions when adapter supports it |
| `session.takeover` | takeover methods | switch agent/human control |
| `secret.input` | secret methods | model-excluded sensitive input |
| `session.close` | `SessionRuntime.close` | idempotent close + cleanup evidence |
| `output.read` | `SessionRuntime.readOutputRef` | range-read durable output, even after close |
| `receipt.get` | `SessionRuntime.getReceipt` | retrieve execution evidence |

The live Federation bridge should normally expose one bounded Host Control profile under existing `pai_action_run`; it need not export this table as eleven schemas.
