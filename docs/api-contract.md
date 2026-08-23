# Game Platform REST API Contract

Base path: `/api/v1`

---

## Response envelope

All successful HTTP responses use this shape:

```json
{
  "statusCode": 200,
  "success": true,
  "message": "Human-readable status",
  "data": { },
  "timestamp": "2026-08-23T16:00:00.000Z"
}
```

Errors:

```json
{
  "success": false,
  "statusCode": 400,
  "message": "Error description",
  "errors": { },
  "timestamp": "2026-08-23T16:00:00.000Z"
}
```

Amounts and balances are always **integer strings** (no decimals), e.g. `"500"`.

---

## 1. Platform app integration (app backend → game backend)

**Full documentation for the 4 integration endpoints:** [platform-integration-api.md](./platform-integration-api.md)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/integrations/users/sync` | Register or update user |
| POST | `/integrations/users/coins` | Credit coins app → game |
| GET | `/integrations/users/:external_user_id/coins` | Get balance |
| POST | `/integrations/users/coins/withdraw` | Withdraw coins game → app |

All integration requests require HMAC headers (`X-App-Package`, `X-Timestamp`, `X-Signature`). See the linked doc for bodies, responses, and signing examples.

---

## 2. Admin — platform apps (setup)

Requires admin bearer session. Mutations need `Idempotency-Key`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/platform-apps` | List apps |
| GET | `/admin/platform-apps/:app_id` | Get one app |
| POST | `/admin/platform-apps` | Create app (returns `signing_secret` once) |
| PATCH | `/admin/platform-apps/:app_id` | Update app name, sha_key, status |
| DELETE | `/admin/platform-apps/:app_id` | Delete app |
| POST | `/admin/platform-apps/:app_id/regenerate-signing-secret` | Rotate signing secret |

**Create body:**

```json
{
  "app_name": "Greedy Live",
  "package_name": "com.example.greedy",
  "sha_key": "AA:BB:CC:DD:EE:FF",
  "status": "active"
}
```

| Field | Purpose |
|-------|---------|
| `app_name` | Display name |
| `package_name` | Android package ID; used in `X-App-Package` |
| `sha_key` | Android signing certificate fingerprint (attestation only, not API auth) |
| `signing_secret` | Auto-generated on create; used for HMAC (shown once) |

---

## 3. Game player APIs (in-game UI)

Use these when the **player is inside a game screen**.  
These are separate from app integration above.

**Auth (dev only today):** `X-User-Id: <internal-wallet-user-id>` when `ALLOW_DEV_IDENTITY_HEADER=true`.  
Production will use platform user identity after player auth is wired.

### Shared bet body (Greedy, Teen Patti, Lucky 77, Greedy Classic)

Used only for **placing bets inside a game round**:

| Field | Description |
|-------|-------------|
| `round_id` | ID of the current open round (from snapshot) |
| `option_id` | ID of the symbol/hand/option the player picks (from snapshot) |
| `amount` | Bet size as positive integer string |
| `client_request_id` | Unique idempotency key per bet attempt (12–128 chars) |

```json
{
  "round_id": "cm12345678901234567890123",
  "option_id": "cm22345678901234567890123",
  "amount": "500",
  "client_request_id": "device-unique-bet-request-id"
}
```

### Greedy

| Method | Path | Auth |
|--------|------|------|
| GET | `/games/greedy/snapshot` | Player |
| POST | `/games/greedy/bets` | Player |
| GET | `/games/greedy/my-bets?page=1&limit=20` | Player |
| GET | `/games/greedy/rounds?page=1&limit=20` | Public |
| GET | `/games/greedy/rounds/:round_id` | Public |

### Teen Patti

| Method | Path | Auth |
|--------|------|------|
| GET | `/games/teen-patti/snapshot` | Player |
| POST | `/games/teen-patti/bets` | Player |
| GET | `/games/teen-patti/my-bets?page=1&limit=20` | Player |
| GET | `/games/teen-patti/rounds?page=1&limit=20` | Public |
| GET | `/games/teen-patti/rounds/:round_id` | Public |

### Lucky 77

| Method | Path | Auth |
|--------|------|------|
| GET | `/games/lucky-77/snapshot` | Player |
| POST | `/games/lucky-77/bets` | Player |
| GET | `/games/lucky-77/my-bets?page=1&limit=20` | Player |
| GET | `/games/lucky-77/rounds?page=1&limit=20` | Public |
| GET | `/games/lucky-77/rounds/:round_id` | Public |

### Greedy Classic

| Method | Path | Auth |
|--------|------|------|
| GET | `/games/greedy-classic/snapshot` | Player |
| POST | `/games/greedy-classic/bets` | Player |
| GET | `/games/greedy-classic/my-bets?page=1&limit=20` | Player |
| GET | `/games/greedy-classic/rounds?page=1&limit=20` | Public |
| GET | `/games/greedy-classic/rounds/:round_id` | Public |

### Wallet (player)

| Method | Path | Auth |
|--------|------|------|
| GET | `/wallets/me` | Player |
| GET | `/wallets/me/transactions?page=1&limit=20` | Player |

---

## 4. Admin — games, wallet, auth

Admin uses `Authorization: Bearer <session_token>`. Mutations require `Idempotency-Key`.

### Auth

| Method | Path |
|--------|------|
| POST | `/admin/auth/login` |
| GET | `/admin/auth/me` |
| POST | `/admin/auth/logout` |
| POST | `/admin/auth/password/change` |
| GET | `/admin/auth/sessions` |
| POST | `/admin/auth/sessions/:session_id/revoke` |

### Admin users & policy

| Method | Path |
|--------|------|
| GET/POST/PATCH | `/admin/admin-users`, `/admin/admin-users/:admin_id` |
| GET/PATCH | `/admin/policy` |
| GET/POST | `/admin/approvals`, `/admin/approvals/:approval_id/approve|reject` |

### Wallet admin

| Method | Path |
|--------|------|
| GET | `/admin/wallets?search=&page=1&limit=20` |
| POST | `/admin/wallets/adjust` |

**Adjust body:**

```json
{
  "user_id": "internal-platform-user-id",
  "direction": "credit",
  "amount": "10000",
  "reason": "support adjustment",
  "ticket_reference": "SUP-12345"
}
```

### Game admin (per game: `greedy`, `teen-patti`, `lucky-77`, `greedy-classic`)

Under `/admin/games/{game}/`:

| Method | Path pattern |
|--------|--------------|
| GET | `runtime`, `config-versions`, `overview`, `health`, `metrics`, `audit-logs`, `alerts`, `rounds`, `rounds/:round_id`, … |
| POST | `config-versions`, `config-versions/validate`, `resume`, `pause`, `cancel-current-round`, `availability`, … |

Greedy config create requires 8 options. Teen Patti requires 3 decks + `rake_bps`. Lucky 77 requires 3 options.

High-risk actions (publish config, large wallet adjust, round cancel) use the approval workflow.

---

## 5. Health

| Method | Path |
|--------|------|
| GET | `/health/live` |
| GET | `/health/ready` |

---

## Quick reference: which API for what?

| Your task | Doc |
|-----------|-----|
| Register user from app | [platform-integration-api.md](./platform-integration-api.md) → sync |
| Send coins to game | [platform-integration-api.md](./platform-integration-api.md) → credit |
| Check coin balance | [platform-integration-api.md](./platform-integration-api.md) → get balance |
| Pull coins back to app | [platform-integration-api.md](./platform-integration-api.md) → withdraw |
| Place bet in Greedy UI | `POST /games/greedy/bets` (needs `round_id`, `option_id`) |
| Register app + get signing secret | Admin `POST /admin/platform-apps` |
