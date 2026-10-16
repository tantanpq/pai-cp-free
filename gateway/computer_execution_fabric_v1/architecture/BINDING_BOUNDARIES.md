# Live Binding Boundaries

The reference deliberately stops at seams whose correctness depends on the current machine/runtime:

- current `pai_action_run` input schema and tool visibility;
- current `chief_chat_bridge_v1` internal profile resolver;
- current Claim/fence freshness API;
- current effect/allowed-root/network policy owner;
- Windows ConPTY implementation and control-sequence behavior;
- Windows Job Object / process-tree termination and PID-reuse guard;
- ProgramData/service identity ACLs;
- current resident generation and launcher pointer;
- live host cards and Farm/provider availability.

A binder should change only these seams. It should not rewrite the session contract or create a parallel MCP/queue/DB/scheduler.
