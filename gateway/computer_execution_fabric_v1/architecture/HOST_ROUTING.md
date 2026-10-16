# Host Routing R1

Routing consumes fresh capability cards supplied by the current PAI host/runtime owner. This package stores no permanent host role and assumes no fixed Farm width.

Selection order:

1. existing `session_id` -> exact `owner_host` (no silent migration);
2. transport currently online;
3. current authority + Host Control eligibility explicitly true;
4. all required technical capabilities present;
5. locality/data gravity;
6. fresh headroom/load;
7. deterministic tie-break.

Historical aliases, stale topology, chat memory and old host counts are not routing authority.

Semantic mobility is a later operation: snapshot cwd/repo/branch/environment/artifact pointers, admit a new session on another host, and link both through the same mission/root. Do not claim PTY byte migration.
