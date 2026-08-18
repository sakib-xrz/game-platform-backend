# Greedy Platform Backend

Production-oriented backend foundation for a multi-game platform. Greedy is the first game module. The code follows the supplied Express backend pattern: module routes/controllers/services/validation, shared middleware/utilities, Prisma, and `/api/v1` routing.

## Locked technical choices

- TypeScript + Express
- Prisma ORM 7 + PostgreSQL (`@prisma/adapter-pg`)
- Redis + Socket.IO Redis Streams adapter
- All Prisma primary keys use `cuid()`
- Database fields use `snake_case`
- Virtual-currency amounts use PostgreSQL `BIGINT` / Prisma `BigInt`
- PostgreSQL is authoritative; Redis is rebuildable realtime infrastructure
- Critical client writes use REST; Socket.IO is realtime delivery
- API process and authoritative Greedy worker are separate runtime processes
- Transactional outbox for committed realtime events
- Serializable retry for wallet/bet/settlement critical sections
- Versioned Greedy configuration so a running round never changes mid-flight

## Project structure

```text
src/
├── app.ts
├── server.ts                 # HTTP + Socket.IO + outbox publisher
├── worker.ts                 # authoritative Greedy lifecycle process
├── config/
├── infrastructure/
│   ├── redis/
│   └── socket/
├── middlewares/
├── modules/
│   ├── greedy/
│   ├── wallet/
│   └── game-admin/
├── routes/
├── utils/
└── workers/
    ├── greedy-round.worker.ts
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

The seed creates the `COIN` currency, `GREEDY` game, a published version-1 Greedy config, and a stopped runtime. Start rounds with the admin resume endpoint.

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

Until platform RBAC is connected, operational admin endpoints use:

```http
X-Admin-Key: <ADMIN_API_KEY>
X-Admin-Actor-Id: optional-admin-id
```

Set a strong `ADMIN_API_KEY` in `.env`. Replace this guard with platform RBAC later at `src/middlewares/admin-key.ts`.

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
| GET | `/wallets/me` | Shared platform wallet |
| GET | `/wallets/me/transactions?page=1&limit=20` | Immutable wallet ledger history |

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

Every connection joins `game:greedy`. Authenticated identity integration should additionally join `user:<user_id>`.

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

## Inputs still needed later

No input is required to run the backend locally. When the related work reaches these areas, provide:

1. **Real auth integration** — platform user-token/session contract; wire it into `player-context.ts` and Socket handshake.
2. **Greedy visual/theme data** — final 8 option names/images/icons. Images are referenced by `image_url`; they are not stored in the database.
3. **Production secrets** — `DATABASE_URL`, `REDIS_URL`, `ADMIN_API_KEY`, allowed frontend origins.
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
