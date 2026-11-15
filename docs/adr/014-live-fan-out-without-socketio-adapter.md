# ADR 014: Live fan-out over Redis pub/sub and `md:events`, without the Socket.IO Redis adapter

| | |
|---|---|
| Status | Accepted |
| Date | 2026-11-10 |
| Deciders | Phase 2 implementation, within the architecture approved in Phase 0 |
| Supersedes | The "Redis adapter and emitter" part of [ADR 007](007-socketio-websocket-only.md). Socket.IO, WebSocket-only, namespace `/v1`, token handshake and `seq` resync stand. |
| Related | [Architecture §6 Event backbone, §10 Real-time gateway](../phase-0/03-architecture.md#10-real-time-gateway) · [API contracts §5](../phase-0/06-api-contracts.md#5-websocket-protocol) · [ADR 003](003-redis-streams-and-bullmq.md) · Risk R25 |

## Context

ADR 007 chose `@socket.io/redis-adapter` (so several `api` instances share rooms) and `@socket.io/redis-emitter` (so the `ingestor` can publish to rooms). It also recorded the risk: those packages were last published in March 2024 (adapter 8.3.0) and January 2023 (emitter 5.1.0), and had to be proven with ioredis 6 (R25).

Phase 2 had to decide before writing the gateway. Two facts settled it:

- The adapter's job is to forward every room broadcast from each instance to all the others. In this system almost nothing is broadcast by an `api` instance on its own: market data comes from the `ingestor`, durable events come from the `md:events` stream, and health is computed locally by each instance. The adapter would mostly forward messages that every instance can already read from Redis itself.
- The emitter writes the adapter's private wire format (msgpack frames on adapter channels). Depending on an unmaintained package for the format of our highest-volume path is the risk R25 described.

## Decision

The gateway uses **Socket.IO 4.8 without an adapter**. Each `api` instance delivers to its own sockets only, from two Redis sources that every instance reads:

| Messages | Source | Delivery |
|---|---|---|
| Non-durable channels: `ticker:{id}` (4 Hz), `book:{id}` (10 Hz), `candles:{id}:{tf}` (1 Hz and on close), `spread` on `market:{id}` (1 Hz) | The `ingestor` publishes each envelope `{ch, ts, type, data}` to the Redis pub/sub channel `live:{channel}` | Every instance `PSUBSCRIBE live:*` and emits to the local room as a **volatile** message (dropped, never queued, for a socket that is not writable). The last message per channel is kept as the subscribe snapshot. |
| Durable channels: `trades:{id}`, `market:{id}` (gaps, feed status, walls) | Producers append to the `md:events` stream (as in ADR 003) | Every instance tails the stream (`XREAD BLOCK`) and emits each entry, with its stream id as `seq`, to the local room. Resync after a reconnect replays from the same stream (`XRANGE`), or answers with a snapshot when the position has been trimmed. |
| `system:health` | Computed by each instance | On change and at least every 10 s, to local subscribers. |

Because no message travels between `api` instances, adding an instance needs no coordination, and a crashed instance loses nothing (its clients reconnect to another one and resync from the stream).

## Consequences

**Positive**

- No dependency on unmaintained packages or on their private wire format. Envelopes are plain JSON that any process can publish and any tool can inspect (`redis-cli PSUBSCRIBE 'live:*'`).
- Multi-instance delivery is correct by construction: each instance serves its own sockets from shared sources, so there is nothing to duplicate or lose between instances.
- The ingestor stays independent of Socket.IO.

**Negative and costs**

- Every `api` instance receives every live message (about 9 instruments × (4 + 10 + 7) messages per second today, a few hundred kB/s), whether or not it has subscribers. It skips the work for rooms without members. At hundreds of instruments this would need per-instance subscriptions to only the channels it serves.
- A feature that needs one instance to reach sockets on another (for example a per-user notification produced by an API request) must also go through Redis (a stream or a pub/sub channel), not through `io.to(...)`. The alerts phase will add a `user:{id}` stream for that.

**What we must do because of it**

- Keep the envelope format in `@cip/contracts` (`Envelope`) and the channel names in `channels.*`, so producers and the gateway cannot drift.
- Phase 13's load test runs two `api` instances to exercise this.

## Alternatives considered

| Option | Why not chosen |
|---|---|
| `@socket.io/redis-adapter` + `redis-emitter` (ADR 007) | Unmaintained packages on the highest-volume path, private wire format, and little to share between instances in this design. |
| `@socket.io/redis-streams-adapter` | Maintained, and offers connection-state recovery, but still forwards every broadcast between instances and still needs an emitter for the ingestor. Our durable channels already resync from `md:events`. |
| Ingestor as a Socket.IO server | Couples the market-data process to client connections and authentication; contradicts the service split (ADR 002). |
