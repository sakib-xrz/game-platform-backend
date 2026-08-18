# Greedy Socket Contract

The Socket layer is notification/recovery acceleration, not the authoritative write path. Critical player writes such as placing a bet use REST.

## Rooms

- `game:greedy` — all Greedy clients
- `user:<user_id>` — user-private wallet/bet notifications after real auth is integrated

## Server -> client events

### `platform.connected`

```json
{
  "socket_id": "...",
  "server_time": "2026-08-18T00:00:00.000Z"
}
```

### `platform.game.paused`

```json
{
  "event_id": "<cuid>",
  "game_code": "GREEDY",
  "current_round_will_finish": true
}
```

### `platform.game.resumed`

```json
{
  "event_id": "<cuid>",
  "game_code": "GREEDY"
}
```

### `greedy.round.opened`

Contains `round_id`, `round_number`, server timestamps, and public option data. Probability weights are intentionally not sent.

### `greedy.round.locked`

Contains `round_id` and `locked_at`.

### `greedy.round.drawing`

Contains `round_id`, `drawing_started_at`, and `result_reveal_at`. The winning result is intentionally absent.

### `greedy.round.result`

Emitted only at reveal time. Contains the winning public option and `revealed_at`.

### `greedy.round.settled`

Round-level settlement has completed.

### `greedy.round.closed`

The round is immutable/closed and the runtime can create the next round.

### `greedy.round.cancelled`

The round was cancelled before reveal. Refund processing follows.

### `greedy.round.refunded`

All accepted bets in the cancelled round have been refunded and the runtime was released.

### `greedy.bet.accepted`

Private `user:<user_id>` notification mirroring the accepted REST bet response.

### `wallet.balance.updated`

Private user event. `reason` is currently one of `greedy_bet`, `greedy_win`, `greedy_refund`, or `admin_adjustment`.

## Client recovery rule

A Socket reconnect is not enough to establish authoritative state. On initial load, WebView resume, browser visibility resume, or unsuccessful Socket state recovery, fetch:

```text
GET /api/v1/games/greedy/snapshot
```

Then continue listening to Socket events. Every durable outbox event includes `event_id`; clients should de-duplicate repeated IDs.
