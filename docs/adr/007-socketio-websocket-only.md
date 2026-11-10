# ADR 007: Socket.IO, WebSocket-only, with Redis adapter and emitter

| | |
|---|---|
| Status | Accepted |
| Date | 2026-11-10 |
| Deciders | Project owner (Phase 0 approval) |
| Related | [Architecture §10 Real-time gateway](../phase-0/03-architecture.md#10-real-time-gateway) · [API contracts §5 WebSocket protocol](../phase-0/06-api-contracts.md#5-websocket-protocol) · [Feasibility §7.2](../phase-0/02-feasibility.md#72-pinned-versions) · [Risks R25](../phase-0/04-risks-and-dependencies.md#1-risk-register) · [ADR 003](003-redis-streams-and-bullmq.md) |

## Context

Clients (web and desktop) need live prices, books, candles, setups and alerts. The gateway lives in the `api` service, which must scale horizontally behind Caddy. The protocol needs rooms (per channel), acknowledgements, reconnection handling and re-authentication when a token expires. High-frequency data (ticker, book) is produced by the `ingestor`, a different process from the `api`.

Feasibility §7.2 notes that `@socket.io/redis-adapter` (8.3.0) and `redis-emitter` (5.1.0) were last published in 2024 and 2023, and that they must be tested with ioredis 6 in Phase 1 (R25).

## Decision

Use **Socket.IO** with `transports: ['websocket']` only, namespace `/v1`, with:

- the **Redis adapter** so several `api` instances share rooms, and the **Redis emitter** so the `ingestor` can publish high-frequency messages to rooms without being a Socket.IO server;
- an access token in the handshake, with `auth:expired` and `auth:renew` for renewal without reconnecting;
- fixed rates (ticker 4 Hz, book 10 Hz with the top 50 levels, in-progress candles 1 Hz) and conflation under backpressure. A client over its buffer limit for 30 s is disconnected;
- `seq` on durable channels equal to the Redis stream entry id, so a client can resync after a reconnect (API contracts §5.4).

Because there is no HTTP long-polling fallback, **no sticky sessions** are needed.

## Consequences

**Positive**

- Rooms, acknowledgements and reconnection come with the library instead of being written by us.
- The `api` stays stateless and scales by adding instances, with no sticky routing in Caddy.
- The `ingestor` does not need to know about connected clients.

**Negative and costs**

- Clients that cannot open a WebSocket cannot connect at all. We accept this for the supported browsers and the desktop WebViews.
- The adapter and emitter packages are old. If they fail with ioredis 6, we need an alternative adapter (the R25 fallback). The sources do not name one.
- The Socket.IO protocol adds framing overhead compared with raw WebSocket messages.

**What we must do because of it**

- Run the Phase 1 spike for adapter and emitter with ioredis 6.
- Add integration tests for resync (replay from stream, then snapshot fallback) and for backpressure and disconnect behaviour.
- Include a multi-instance `api` case in the end-to-end tests, so room sharing is exercised.

## Alternatives considered

| Option | Why not chosen |
|---|---|
| **Raw `ws`** | More code for rooms, acknowledgements and reconnection (architecture §20). We would rewrite what Socket.IO provides. |
| Socket.IO with long-polling fallback | Needs sticky sessions behind the proxy, which contradicts the stateless `api`. |
