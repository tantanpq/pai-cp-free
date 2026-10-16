# PAI Chief Live Session V1

A SQLite-first, operational-only session journal bound to a user, PAI identity, project, Chief role, and optional external chat/thread IDs. It records bounded checkpoints and hash-chained events for begin, commit, resume, correct, forget, export, rollback, and close.

This module reuses the active Chief contract's authority boundary: it never selects nodes, claims work, advances a graph, admits canonical memory, or creates external effects. Candidate durable deltas are explicitly stored as `CANDIDATE_NOT_ADMITTED`; canonical and user-truth admission remain with their existing authorities. Credentials, OAuth/raw authorization values, and unrestricted chat history are rejected.

Run `npm test` for the focused contract suite.
