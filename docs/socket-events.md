# Greedy Socket Contract

The Socket layer is notification/recovery acceleration, not the authoritative write path. Critical player writes such as placing a bet use REST.

## Rooms

- `game:greedy` — all Greedy clients
- `game:teen-patti` — all Teen Patti clients
- `game:lucky-77` — all Lucky 77 clients
- `game:greedy-classic` — all Greedy Classic clients
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

Emitted only at reveal time. Contains the winning public option, `revealed_at`, and `top_winners`. `top_winners` has at most three real users ranked by aggregate stake-inclusive gross payout, then earliest winning bet, then user ID. All winning users are still paid; this list is only the podium.

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

### `greedy.bet.placed`

Public `game:greedy` notification for an individual accepted tap. Clients use it for coin animation and replace their in-memory aggregate with the newer authoritative count/total; snapshot remains authoritative after reconnect.

```json
{
  "event_id": "<outbox-event-id>",
  "bet_id": "<bet-id>",
  "round_id": "<round-id>",
  "option_id": "<option-id>",
  "amount": "1000",
  "accepted_at": "2026-08-22T00:00:00.000Z",
  "total_amount": "3000",
  "bet_count": 2,
  "first_bet_at": "2026-08-22T00:00:00.000Z",
  "last_bet_at": "2026-08-22T00:00:01.000Z",
  "bettor": {
    "user_id": "user-001",
    "display_name": null,
    "avatar_url": null
  }
}
```

The public event intentionally excludes wallet balance and `client_request_id`. `amount` is the individual tap for animation; `total_amount`, `bet_count`, and the aggregate timestamps are authoritative post-bet values for that round/option/user. Clients can ignore an out-of-order event whose `bet_count` is not newer than their current aggregate. Profile fields remain null until populated by a trusted platform identity integration.

### `wallet.balance.updated`

Private user event. `reason` is currently one of `greedy_bet`, `greedy_win`, `greedy_refund`, `teen_patti_bet`, `teen_patti_win`, `teen_patti_refund`, `lucky_77_bet`, `lucky_77_win`, `lucky_77_refund`, `greedy_classic_bet`, `greedy_classic_win`, `greedy_classic_refund`, or `admin_adjustment`.

## Teen Patti events

New connections join `game:greedy`, `game:teen-patti`, `game:lucky-77`, and `game:greedy-classic`. Clients should ignore events they do not handle.

### `teen_patti.round.opened`

Contains `round_id`, `round_number`, timestamps, `rake_bps`, three public hands, enabled chip values, `preview_cards` (one real card per hand), and `result_commitment`. It never contains the other six cards, hand ranks, or winner.

### `teen_patti.round.locked`

Contains `round_id` and `locked_at`.

### `teen_patti.round.drawing`

Contains `round_id`, `drawing_started_at`, and `result_reveal_at`. The two remaining cards per hand and winner are still hidden.

### `teen_patti.round.result`

Emitted only at reveal. Contains the winning hand, the three 3-card hands (`cards`, `category`, `rank_key`), `revealed_at`, and the audit fields needed to match the previously published `result_commitment`.

For `teen-patti-predeal-v2`, clients can recompute the commitment as SHA-256 of the pipe-joined values `round_id`, `config_version_id`, `winning_option.id`, `algorithm_version`, `entropy_digest`, canonical JSON for `hands` (object keys sorted lexicographically at every level), and `generated_at`, in that exact order. Canonical JSON makes the commitment stable across PostgreSQL JSONB persistence.

### `teen_patti.round.settled` / `closed` / `cancelled` / `refunded`

Same round-lifecycle meaning as Greedy.

### `teen_patti.bet.accepted`

Private `user:<user_id>` notification mirroring the accepted REST bet.

### `teen_patti.bet.placed`

Public `game:teen-patti` notification emitted through the transactional outbox for each accepted tap. `amount` is the individual tap. `user_total_amount` is authoritative for that round/option/user, while `option_total_amount`, `player_count`, and `round_bet_count` are authoritative post-bet public totals. `round_bet_count` counts every accepted tap in the round and is computed after the insert in the same serializable transaction.

```json
{
  "event_id": "<outbox-event-id>",
  "bet_id": "<bet-id>",
  "round_id": "<round-id>",
  "option_id": "<hand-id>",
  "user_id": "user-001",
  "display_name": null,
  "avatar_url": null,
  "amount": "500",
  "accepted_at": "2026-08-23T00:00:02.000Z",
  "user_total_amount": "700",
  "option_total_amount": "1700",
  "bet_count": 2,
  "first_bet_at": "2026-08-23T00:00:01.000Z",
  "last_bet_at": "2026-08-23T00:00:02.000Z",
  "player_count": 3,
  "round_bet_count": 9
}
```

The public event excludes wallet balance and `client_request_id`. Clients should replace a user/option aggregate only when the incoming `bet_count`/`last_bet_at` is newer. Treat snapshot `round.round_bet_count` as the baseline: ignore events at or below that watermark, accept the next sequential count, and refetch when a higher event exposes a gap. Because active-round bets only add stake, merge `option_total_amount` and `player_count` using the larger value while recovering from event reordering.

## Lucky 77 events

Same round lifecycle as Greedy under the `lucky_77.*` event namespace. New connections also join `game:lucky-77`.

### `lucky_77.round.opened`

Contains `round_id`, `round_number`, server timestamps, public options, and chip values. Probability weights are intentionally not sent.

### `lucky_77.round.locked`

Contains `round_id` and `locked_at`.

### `lucky_77.round.drawing`

Contains `round_id`, `drawing_started_at`, and `result_reveal_at`. The winning result is intentionally absent.

### `lucky_77.round.result`

Emitted only at reveal time. Contains the winning public option, `winning_slot_index`, and `revealed_at`.

### `lucky_77.round.settled` / `closed` / `cancelled` / `refunded`

Same round-lifecycle meaning as Greedy.

### `lucky_77.bet.accepted`

Private `user:<user_id>` notification mirroring the accepted REST bet.

## Greedy Classic events

Same round lifecycle as Greedy under the `greedy_classic.*` event namespace. New connections also join `game:greedy-classic`.

### `greedy_classic.round.opened`

Contains `round_id`, `round_number`, server timestamps, and public option data. Probability weights are intentionally not sent.

### `greedy_classic.round.locked`

Contains `round_id` and `locked_at`.

### `greedy_classic.round.drawing`

Contains `round_id`, `drawing_started_at`, and `result_reveal_at`. The winning result is intentionally absent.

### `greedy_classic.round.result`

Emitted only at reveal time. Contains the winning public option, `revealed_at`, and `top_winners`. `top_winners` has at most three real users ranked by aggregate stake-inclusive gross payout, then earliest winning bet, then user ID. All winning users are still paid; this list is only the podium.

### `greedy_classic.round.settled` / `closed` / `cancelled` / `refunded`

Same round-lifecycle meaning as Greedy.

### `greedy_classic.bet.accepted`

Private `user:<user_id>` notification mirroring the accepted REST bet.

### `greedy_classic.bet.placed`

Public `game:greedy-classic` notification for an individual accepted tap, mirroring `greedy.bet.placed`. Clients use it for coin animation and replace their in-memory aggregate with the newer authoritative count/total; snapshot remains authoritative after reconnect.

```json
{
  "event_id": "<outbox-event-id>",
  "bet_id": "<bet-id>",
  "round_id": "<round-id>",
  "option_id": "<option-id>",
  "amount": "1000",
  "accepted_at": "2026-08-25T00:00:00.000Z",
  "total_amount": "3000",
  "bet_count": 2,
  "first_bet_at": "2026-08-25T00:00:00.000Z",
  "last_bet_at": "2026-08-25T00:00:01.000Z",
  "bettor": {
    "user_id": "user-001",
    "display_name": null,
    "avatar_url": null
  }
}
```

The public event intentionally excludes wallet balance and `client_request_id`. `amount` is the individual tap for animation; `total_amount`, `bet_count`, and the aggregate timestamps are authoritative post-bet values for that round/option/user. Greedy Classic now allows a user to back multiple options in the same round, so the aggregate is scoped per round/option/user.

## Client recovery rule

A Socket reconnect is not enough to establish authoritative state. On initial load, WebView resume, browser visibility resume, or unsuccessful Socket state recovery, fetch:

```text
GET /api/v1/games/greedy/snapshot
```

or, for Teen Patti:

```text
GET /api/v1/games/teen-patti/snapshot
```

or, for Lucky 77:

```text
GET /api/v1/games/lucky-77/snapshot
```

or, for Greedy Classic:

```text
GET /api/v1/games/greedy-classic/snapshot
```

Then continue listening to Socket events. Every durable outbox event includes `event_id`; clients should de-duplicate repeated IDs.
