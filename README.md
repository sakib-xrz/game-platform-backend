# Greedy Platform Backend

Production-oriented backend foundation for a multi-game platform. **Greedy** is the first game (8 weighted symbols). **Teen Patti** is the second (three card decks, highest hand wins the pot minus rake). The code follows the supplied Express backend pattern: module routes/controllers/services/validation, shared middleware/utilities, Prisma, and `/api/v1` routing.

## Locked technical choices

- TypeScript + Express
- Prisma ORM 7 + PostgreSQL (`@prisma/adapter-pg`)
- Redis + Socket.IO Redis Streams adapter
- All Prisma primary keys use `cuid()`
- Database fields use `snake_case`
- Virtual-currency amounts use PostgreSQL `BIGINT` / Prisma `BigInt`
- PostgreSQL is authoritative; Redis is rebuildable realtime infrastructure
- Critical client writes use REST; Socket.IO is realtime delivery
- API process and authoritative game worker are separate runtime processes
- Transactional outbox for committed realtime events
- Serializable retry for wallet/bet/settlement critical sections
- Versioned Greedy configuration so a running round never changes mid-flight

## Project structure

```text
src/
├── app.ts
├── server.ts                 # HTTP + Socket.IO + outbox publisher
├── worker.ts                 # authoritative Greedy + Teen Patti lifecycle process
├── config/
├── infrastructure/
│   ├── redis/
│   └── socket/
├── middlewares/
├── modules/
│   ├── greedy/
│   ├── teen-patti/
│   ├── wallet/
│   └── game-admin/
├── routes/
├── utils/
└── workers/
    ├── greedy-round.worker.ts
    ├── teen-patti-round.worker.ts
    ├── outbox.worker.ts
    └── worker-lease.ts
```

## Greedy lifecycle

```text
betting_open
  -> betting_locked
  -> result_ready
  -> drawing
  -> result_revealed
  -> settling
  -> settled
  -> closed
  -> next round
```

A cancelled pre-reveal round is refunded by the worker before the runtime is released.

## Local setup

Prisma 7 is configured through `prisma.config.ts`; the generated client is written to `src/generated/prisma` and PostgreSQL uses the `pg` driver adapter.


```bash
cp .env.example .env
docker compose up -d
npm install
npm run prisma:generate
npm run prisma:migrate -- --name init
npm run prisma:harden
npm run prisma:seed
```

Run the API/socket process:

```bash
npm run dev
```

Run the authoritative game worker in another terminal:

```bash
npm run dev:worker
```

The seed creates the `COIN` currency, `GREEDY` and `TEEN_PATTI` games, published version-1 configs, and **stopped** runtimes. Resume each game independently with its admin resume endpoint. One `npm run dev:worker` process holds both `game-worker:greedy` and `game-worker:teen-patti` leases.

## Identity integration

The final platform auth/user/RBAC implementation was intentionally not copied from the reference project.

For local development only, set:

```env
ALLOW_DEV_IDENTITY_HEADER=true
```

and send:

```http
X-User-Id: any-platform-user-id
```

**Before production**, integrate the real platform authentication in:

```text
src/middlewares/player-context.ts
src/infrastructure/socket/socket.ts
```

Those are the two identity integration seams. Do not allow the development identity header in production.

## Admin integration

Admin operations use password authentication with opaque bearer sessions. The
legacy `X-Admin-Key`/`X-Admin-Actor-Id` mechanism is deprecated and must not be
used by the production panel. `ADMIN_API_KEY` remains only for local migration
compatibility and should be removed once all clients have moved.

The trusted Next/BFF layer should call:

```http
POST /api/v1/admin/auth/login
Content-Type: application/json
```

```json
{
  "email": "admin@example.com",
  "password": "AdminPassword123"
}
```

The response contains only `session_token`, `expires_at`, and a sanitized
`admin` object (with an optional `csrf_token` if the BFF contract enables it).
Store the opaque token only in the trusted BFF and send it to the backend as:

```http
Authorization: Bearer <session_token>
```

Sessions expire after 30 minutes of inactivity or 12 hours absolutely, with a
maximum of three active sessions per admin. Mutating admin requests require a
unique `Idempotency-Key` header.

The first super admin is created by `npm run prisma:seed` using
`ADMIN_SEED_EMAIL` and `ADMIN_SEED_PASSWORD` (defaults: `admin@example.com` /
`AdminPassword123`). Re-running seed resets that account's password.

The fixed roles are:

| Role | Boundary |
|---|---|
| `super_admin` | Full administration, policy, approvals, and account management |
| `game_operator` | Greedy configuration, runtime, rounds, and game approvals |
| `finance_operator` | Wallet reads/adjustments and finance approvals |
| `support` | Read-only player, wallet, round, and bet access |
| `auditor` | Read-only operational data, approvals, result verification, and audit logs |

Wallet adjustments at or above the configured policy threshold require one
distinct eligible approver. The requester cannot approve or apply their own
request. Approval payloads are hash-checked before application and expire after
24 hours by default.

Important admin endpoints include:

```text
POST /admin/auth/login
GET  /admin/auth/me
POST /admin/auth/logout
POST /admin/auth/password/change
GET  /admin/auth/sessions
GET  /admin/admin-users
GET  /admin/approvals
POST /admin/approvals/:approval_id/approve
POST /admin/approvals/:approval_id/reject
GET  /admin/games/greedy/overview
GET  /admin/games/greedy/rounds
GET  /admin/games/greedy/users/:user_id
GET  /admin/games/greedy/audit-logs
GET  /admin/games/greedy/assets
GET  /admin/games/teen-patti/overview
POST /admin/games/teen-patti/resume
```

Greedy result evidence is append-only. The winner, algorithm, entropy digest,
audit hash, and generated timestamp cannot be changed or deleted. The worker
may record the first reveal timestamp. Audit rows are also append-only; the
retention job may purge only rows older than 365 days using the transaction
setting `app.audit_retention_purge = 'on'`.

For local development, player identity may still use `X-User-Id` only when
`ALLOW_DEV_IDENTITY_HEADER=true`. Never enable that setting in production.

API details are also documented in `docs/api-contract.md`; realtime event semantics are in `docs/socket-events.md`.

## Player APIs

Base URL: `/api/v1`

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health/live` | Liveness |
| GET | `/health/ready` | PostgreSQL + Redis readiness |
| GET | `/games/greedy/snapshot` | Authoritative page/WebView recovery snapshot |
| POST | `/games/greedy/bets` | Place an idempotent bet |
| GET | `/games/greedy/my-bets?page=1&limit=20` | Player bet history |
| GET | `/games/greedy/rounds?page=1&limit=20` | Public result history |
| GET | `/games/greedy/rounds/:round_id` | Public round detail; result hidden until reveal |
| GET | `/games/teen-patti/snapshot` | Teen Patti snapshot (3 hands, one committed preview card each, grouped bettors, rake; full hands hidden until reveal) |
| POST | `/games/teen-patti/bets` | Place an idempotent enabled-chip bet on any hand; repeated/cross-hand taps are allowed until lock |
| GET | `/games/teen-patti/my-bets?page=1&limit=20` | Teen Patti bet history |
| GET | `/games/teen-patti/rounds?page=1&limit=20` | Public Teen Patti result history |
| GET | `/games/teen-patti/rounds/:round_id` | Public round detail; cards hidden until reveal |
| GET | `/wallets/me` | Shared platform wallet |
| GET | `/wallets/me/transactions?page=1&limit=20` | Immutable wallet ledger history |

Admin wallet operations additionally expose `GET /admin/wallets?search=<user_id>&page=1&limit=20` for permission-protected player selection and `POST /admin/wallets/adjust` for audited credit/debit adjustments.

### Place bet

```http
POST /api/v1/games/greedy/bets
X-User-Id: user-001
Content-Type: application/json
```

```json
{
  "round_id": "<current-cuid>",
  "option_id": "<option-cuid>",
  "amount": "500",
  "client_request_id": "bet-device-unique-request-000001"
}
```

`amount` is intentionally an integer string because the backend uses `BigInt` and the future web/Flutter-WebView boundary must not depend on JavaScript number precision.

## Admin/operations APIs

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/admin/games/greedy/runtime` | Runtime/current round/config |
| GET | `/admin/games/greedy/config-versions` | List config versions |
| POST | `/admin/games/greedy/config-versions` | Create immutable draft config |
| POST | `/admin/games/greedy/config-versions/:config_id/publish` | Publish next config |
| POST | `/admin/games/greedy/resume` | Start/continue generating rounds |
| POST | `/admin/games/greedy/pause` | Finish current round, create no next round |
| POST | `/admin/games/greedy/cancel-current-round` | Pre-reveal cancel + exactly-once refund |
| POST | `/admin/wallets/adjust` | Operational credit/debit for testing/admin flows |

### Admin wallet adjustment

```json
{
  "user_id": "user-001",
  "amount": "10000",
  "reason": "development test credit"
}
```

## Socket events

Every connection joins `game:greedy` and `game:teen-patti`. Authenticated identity integration should additionally join `user:<user_id>`.

Server events currently emitted through the transactional outbox:

```text
platform.connected
platform.game.paused
platform.game.resumed

greedy.round.opened
greedy.round.locked
greedy.round.drawing
greedy.round.result
greedy.round.settled
greedy.round.closed
greedy.round.cancelled
greedy.round.refunded
greedy.bet.accepted

teen_patti.round.opened
teen_patti.round.locked
teen_patti.round.drawing
teen_patti.round.result
teen_patti.round.settled
teen_patti.round.closed
teen_patti.round.cancelled
teen_patti.round.refunded
teen_patti.bet.accepted
teen_patti.bet.placed

wallet.balance.updated
```

Every outbox Socket payload includes `event_id`; clients should de-duplicate repeated delivery by this ID.

## Seed game math

The technical seed uses 8 options with multipliers:

```text
4x, 5x, 6x, 7x, 8x, 10x, 15x, 20x
```

and inverse-style weights:

```text
210, 168, 140, 120, 105, 84, 56, 42
```

This produces approximately the same expected return per option (~90.8%) under the stake-inclusive payout convention. It is a technical baseline, not a claim about IMO/Likee/BIGO proprietary game math. Before a real-money/redeemable-currency launch, product/legal/game-economy review is required.

## Teen Patti rules

Three decks (`DECK_A` / `DECK_B` / `DECK_C`). Bet on any 1–3 during `betting_open`. After lock, one 52-card deck is shuffled with crypto RNG and 9 cards are dealt (3 per deck). Hands use Indian Teen Patti ranking (trail, pure sequence, sequence, color, pair, high card; A-2-3 is the highest sequence). Ties for highest are redealt (cap 10). The unique highest deck wins. Pot = all stakes; house takes `rake_bps` (seed 500 = 5%); remainder is split among winning-deck stakes with integer leftover kept by the house. If nobody bet the winner, the house keeps the pot.

## Inputs still needed later

No input is required to run the backend locally. When the related work reaches these areas, provide:

1. **Real auth integration** — platform user-token/session contract; wire it into `player-context.ts` and Socket handshake.
2. **Greedy visual/theme data** — final 8 option names/images/icons. Images are referenced by `image_url`; they are not stored in the database.
3. **Production secrets** — `DATABASE_URL`, `REDIS_URL`, admin bootstrap/recovery credentials, allowed frontend origins, and (when enabled) the Cloudflare R2 and admin webhook secrets.
4. **Production game economy** — final bet limits/chip presets/multipliers/probability weights, supplied through a new config version rather than code changes.

## Production invariants implemented

- Same idempotency key cannot debit a wallet twice.
- Same user cannot receive two aggregate payouts for one round (`round_id + user_id` unique).
- Same bet cannot have duplicate settlement.
- Each round has at most one result.
- Every bet uses the round's frozen config/options.
- Result is generated server-side with Node crypto entropy and weighted integer RNG.
- Result is persisted before drawing and hidden from public APIs until reveal.
- Redis loss does not remove bets, results, balances, or ledger history.
- API restart does not stop the authoritative worker.
- Worker restart resumes the persisted current round.
- Stale outbox claims are reclaimed.
- Pause completes the active round and suppresses the next round.
- Cancel is only allowed before reveal and produces refunds.

## Database hardening

`prisma/hardening.sql` adds idempotent PostgreSQL CHECK constraints for wallet non-negative balance, ledger arithmetic, Greedy limits, positive option math, bet amounts, settlement payouts, payouts and refunds. Run it after the initial migration:

```bash
npm run prisma:harden
```

Prisma migrations remain the schema migration source of truth; the hardening script covers constraints that are clearer to enforce directly in PostgreSQL.

## Build and container

```bash
npm run typecheck
npm test
npm run build
docker build -t greedy-platform-backend .
```

The same image can run the authoritative worker by overriding the command to:

```text
node dist/worker.js
```

For horizontally-scaled Socket.IO deployments, configure sticky sessions at the reverse proxy/load balancer and keep Redis on trusted private infrastructure.
