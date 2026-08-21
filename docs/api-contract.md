# Greedy REST API Contract

Base path: `/api/v1`

During local development with `ALLOW_DEV_IDENTITY_HEADER=true`, player endpoints use `X-User-Id`. This is only an integration seam and must be replaced by the platform's real authentication before production.

## Player/game

### GET `/games/greedy/snapshot`

Returns server time, game/runtime state, active config, current round, public options, current player's bets, wallet, and recent result history. A generated result remains hidden until the reveal state.

### POST `/games/greedy/bets`

Headers:

```text
X-User-Id: user-001
Content-Type: application/json
```

Body:

```json
{
  "round_id": "<cuid>",
  "option_id": "<cuid>",
  "amount": "500",
  "client_request_id": "device-unique-bet-request-id"
}
```

`amount` is an integer string. The server validates the authoritative round, deadline, option/config, limits, wallet balance, and idempotency key inside a serializable database transaction.

### GET `/games/greedy/my-bets?page=1&limit=20`

Player bet history with option/round/settlement information.

### GET `/games/greedy/rounds?page=1&limit=20`

Public revealed-result history.

### GET `/games/greedy/rounds/:round_id`

Round details. Result is withheld until public reveal.

## Teen Patti player/game

Global rounds with three decks. Players may bet on one, two, or all three. After lock the server deals 3×3 cards; the highest Teen Patti hand wins. Winning-deck bets split the round pot minus `rake_bps`. Cards and winner stay hidden until reveal. Integer leftover from the split stays with the house. If nobody bet the winner, the pot stays with the house.

### GET `/games/teen-patti/snapshot`

Same snapshot shape as Greedy, plus `rake_bps` and (after reveal) `result.hands`.

### POST `/games/teen-patti/bets`

Same body as Greedy (`round_id`, `option_id` of a deck, `amount`, `client_request_id`).

### GET `/games/teen-patti/my-bets?page=1&limit=20`

### GET `/games/teen-patti/rounds?page=1&limit=20`

### GET `/games/teen-patti/rounds/:round_id`

## Lucky 77 player/game

Fixed-multiplier wheel cloned from Greedy. Exactly three options (`APPLE`, `WATERMELON`, `SEVENTY_SEVEN`) with a fixed nine-slot map. After lock the worker picks a weighted option, then a uniform matching slot index. Snapshot always includes `slot_map`; after reveal, results include `winning_slot_index`.

### GET `/games/lucky-77/snapshot`

Same snapshot shape as Greedy, plus `slot_map`. Public results include `winning_slot_index`.

### POST `/games/lucky-77/bets`

Same body as Greedy (`round_id`, `option_id`, `amount`, `client_request_id`).

### GET `/games/lucky-77/my-bets?page=1&limit=20`

### GET `/games/lucky-77/rounds?page=1&limit=20`

### GET `/games/lucky-77/rounds/:round_id`

## Wallet

### GET `/wallets/me`

Returns the shared platform `COIN` wallet.

### GET `/wallets/me/transactions?page=1&limit=20`

Immutable wallet ledger history.

## Admin/operations

Admin integration uses password-authenticated opaque bearer sessions. The
trusted same-origin Next/BFF layer logs in through `POST /admin/auth/login`,
stores the returned `session_token` server-side, and forwards subsequent admin
requests with `Authorization: Bearer <session_token>`. Admin mutations require
an `Idempotency-Key`. The legacy `X-Admin-Key` header is deprecated and should
not be used by the production panel.

### GET `/admin/games/greedy/runtime`

Returns persisted runtime, active configuration, and current round.

### GET `/admin/games/greedy/config-versions`

Lists immutable config versions and options.

### POST `/admin/games/greedy/config-versions`

Creates a draft config. Exactly 8 options are currently required, together with 1–12 versioned chip presets. Amounts, chip values, payout numerator/denominator, and probability weights are integer strings.

### POST `/admin/games/greedy/config-versions/validate`

Uses the same body and returns the authoritative `valid`, `failures`, `total_weight`, per-option normalized probability/contribution percentages, and weighted `theoretical_return_percent` preview.

### POST `/admin/games/greedy/config-versions/:config_id/publish-request`

Submits the selected draft for second-admin approval. A running round keeps its frozen old version; only future rounds use a published version.

The legacy `POST /admin/games/greedy/config-versions/:config_id/publish` path is also approval-aware and only submits a request; it never publishes directly.

### POST `/admin/games/greedy/config-versions/publish-approved`

Applies an approved configuration publish request. The original requester applies the approved request, and the payload hash is checked before publishing.

### POST `/admin/games/greedy/resume`

Sets runtime to running. If no current round exists, the authoritative worker creates one.

### POST `/admin/games/greedy/pause`

Stops creation of future rounds. An already-running round finishes safely.

### POST `/admin/games/greedy/cancel-current-round`

Body:

```json
{
  "reason": "operational incident"
}
```

Allowed only before public reveal. The worker performs exactly-once aggregate refunds.

Cancellation exposure at or above the policy threshold returns `202 pending_approval`. The requester applies the approved request through the same endpoint with `approval_id`; current round, cancellable status, reason, exposure, and payload hash are rechecked before mutation.

### Teen Patti admin

Same runtime/config/ops surface under `/admin/games/teen-patti/...`. Config create requires exactly 3 decks and `rake_bps` (0–2000). Approvals use `teen_patti.config.publish` and `teen_patti.round.cancel`.

### Lucky 77 admin

Same runtime/config/ops surface under `/admin/games/lucky-77/...`. Config create requires exactly 3 options with payout numerator/denominator and probability weights. Approvals use `lucky_77.config.publish` and `lucky_77.round.cancel`. Ops rounds and result verification expose `winning_slot_index`.

### POST `/admin/wallets/adjust`

Body:

```json
{
  "user_id": "user-001",
  "direction": "credit",
  "amount": "10000",
  "reason": "development credit",
  "ticket_reference": "SUP-12345"
}
```

Creates a wallet update, immutable ledger entry, audit row, and outbox event transactionally when within policy. At or above the policy threshold, it creates a pending approval; a distinct eligible finance/super admin must approve before the requester applies it.

The player lookup is exact `user_id` only and returns 404 when no existing COIN wallet exists. Wallet amounts and ledger values are decimal strings.

### Greedy operations

`/admin/games/greedy` includes `overview`, `health`, `metrics`, `audit-logs`, `alerts`, config detail/update/clone, paged `rounds` with status/round/config/winner filters, `rounds/:round_id`, `rounds/:round_id/bets`, `rounds/:round_id/result-verification`, and `users/:user_id` wallet/ledger/bet summary. Metrics are bucketed in `Asia/Dhaka` and include accepted/refunded/net stake, payout, gross result, unique bettors, cancellation rate, and settlement latency.

`POST /admin/games/greedy/availability` accepts `active`, `maintenance`, or `disabled`. Only a super admin may disable, and disabling requires no current round. Maintenance pauses future rounds while allowing the current round to finish.

Managed assets use presign/complete or direct compatibility upload. The server decodes and normalizes square PNG/JPEG/WebP images (256–2048px, <=2 MB) to WebP and checks checksum before marking them ready.

### Admin approvals

- `GET /admin/approvals`
- `GET /admin/approvals/:approval_id`
- `POST /admin/approvals/:approval_id/approve`
- `POST /admin/approvals/:approval_id/reject`

Approvals expire after 24 hours by default. A requester cannot approve their own request, and approval payloads are immutable and hash-verified.

## Health

- GET `/health/live`
- GET `/health/ready`
