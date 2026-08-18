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

## Wallet

### GET `/wallets/me`

Returns the shared platform `COIN` wallet.

### GET `/wallets/me/transactions?page=1&limit=20`

Immutable wallet ledger history.

## Admin/operations

Admin integration currently uses `X-Admin-Key` as a temporary seam.

### GET `/admin/games/greedy/runtime`

Returns persisted runtime, active configuration, and current round.

### GET `/admin/games/greedy/config-versions`

Lists immutable config versions and options.

### POST `/admin/games/greedy/config-versions`

Creates a draft config. Exactly 8 options are currently required, together with 1–12 versioned chip presets. Amounts, chip values, payout numerator/denominator, and probability weights are integer strings.

### POST `/admin/games/greedy/config-versions/:config_id/publish`

Retires the previous published config and publishes the selected draft. A running round keeps its frozen old version; only future rounds use the new version.

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

### POST `/admin/wallets/adjust`

Body:

```json
{
  "user_id": "user-001",
  "amount": "10000",
  "reason": "development credit"
}
```

Creates a wallet update, immutable ledger entry, audit row, and outbox event transactionally.

## Health

- GET `/health/live`
- GET `/health/ready`
