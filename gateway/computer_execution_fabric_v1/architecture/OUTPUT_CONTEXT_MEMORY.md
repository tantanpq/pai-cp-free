# Output, Context and Memory R1

## Three layers

```text
PTY output
  -> bounded RAM ByteRingBuffer
  -> durable output spool + index
  -> compact model-visible read / output_ref
```

The RAM ring is a recency cache, not evidence storage. Its cursor is monotonic and may advance past old bytes. If a caller asks for evicted bytes, the live ring reports truncation while the durable spool remains range-readable.

## Model-visible result

The preferred Chief-facing shape is small:

```json
{
  "state": "WAITING_INPUT",
  "outputBytes": 8123401,
  "visibleTailBytes": 8192,
  "visibleTail": "...",
  "outputRef": "pai-output://...",
  "exitCode": null,
  "semanticTaskDone": false
}
```

Do not inject megabytes of stdout into a chat merely because the terminal was industrious.

## Backpressure semantics

Model consumption is decoupled from process output. Slow model reads do not require the PTY to wait for the model; output continues into ring + spool. Host disk/output-rate pressure is a separate resource-engineering condition and should be surfaced to System Control, not reinterpreted as a security denial or semantic Task failure.

## Long-term compaction

A live deployment may segment/compress old spool files after their output_ref/index is durable. Compaction must preserve byte/range provenance or publish an equivalent immutable artifact reference. Transcript compaction may summarize old actor events, but raw evidence should remain available under retention policy until accepted cleanup/archival rules permit deletion.
