# Failure and Recovery R1

| Failure | Required behavior |
|---|---|
| stale/mismatched fence | reject input before adapter write |
| operation policy denied | reject input; session may remain alive |
| model reads slowly | terminal continues; return bounded cursor/tail |
| RAM output pressure | evict old ring bytes, retain disk spool/output_ref |
| terminal echoes secret | redact before ring, spool and transcript |
| adapter exits | preserve output; state `EXITED`; semantic outcome unresolved |
| runtime restart | mark live-looking metadata `ORPHANED` |
| no safe reattach | invoke OS orphan reaper; without verified close -> `LOST` |
| child cleanup unavailable | `CLOSED_CLEANUP_UNVERIFIED`, never pretend clean |
| host disappears | session stays bound to owner host; no hidden substitution |
| one provider/host fails | block only dependent cone; another eligible method may be selected upstream |

Retry/recovery must preserve request/root identity, mutable scope, effect boundary and one-writer semantics. A new transport attempt is not a new authority grant.
