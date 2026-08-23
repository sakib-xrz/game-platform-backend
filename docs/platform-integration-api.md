# Platform App Integration API

Server-to-server API for your **mobile app backend** to sync users and move coins with the game platform.

**Base path:** `/api/v1`  
**Full doc for games/admin:** [api-contract.md](./api-contract.md)

---

## Overview

| # | Method | Path | Purpose |
|---|--------|------|---------|
| 1 | POST | `/integrations/users/sync` | Register or update user profile |
| 2 | POST | `/integrations/users/coins` | Send coins from app → game wallet |
| 3 | GET | `/integrations/users/:external_user_id/coins` | Check game wallet balance |
| 4 | POST | `/integrations/users/coins/withdraw` | Pull coins from game wallet → app |

**Recommended flow:**

```text
sync → credit coins → check balance → (user plays games) → withdraw
```

This document covers two integration surfaces:

| Surface | Who calls | Auth | Purpose |
|---------|-----------|------|---------|
| **Integration API** (this doc, sections 1–4) | Your **app backend** only | HMAC (`X-App-Package`, `X-Timestamp`, `X-Signature`) | Users, wallets, coin transfers |
| **Game player API** ([api-contract.md](./api-contract.md) §3) | **Game UI** inside WebView / browser | Player session (dev: `X-User-Id`; production: to be wired) | Snapshots, bets, realtime events |

The signing secret must **never** ship in the mobile app. Only your app backend signs integration requests.

---

## System architecture

Three systems participate in a full integration:

```text
┌─────────────────┐         HMAC integration API          ┌──────────────────────┐
│  Mobile app     │ ──────────────────────────────────────► │  Your app backend    │
│  (Android/iOS)  │   login, purchase, open game, withdraw  │  (your servers)      │
└────────┬────────┘                                         └──────────┬───────────┘
         │                                                             │
         │ WebView / in-app browser                                    │ POST /integrations/*
         │ game REST + Socket.IO                                       │ (server-to-server)
         ▼                                                             ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                         Game platform backend + worker                               │
│  • Platform users + wallets (COIN)                                                   │
│  • Greedy / Teen Patti / Lucky 77 / Greedy Classic rounds                          │
│  • Socket.IO broadcasts (round state, bets, wallet.balance.updated)                │
└─────────────────────────────────────────────────────────────────────────────────────┘
         ▲
         │ HTTPS (game frontend static assets)
         │
┌────────┴────────┐
│ Game frontend   │  Next.js mobile UI — `/`, `/games/greedy`, `/games/teen-patti`, …
│ (WebView host)  │
└─────────────────┘
```

**Responsibility split**

| Component | Owns | Must not |
|-----------|------|----------|
| **Your app backend** | User accounts in your app, purchases, HMAC signing, when to credit/withdraw | Expose `signing_secret` to clients |
| **Game platform backend** | Game wallets, bets, round outcomes, ledger | Trust unsigned coin movements from the app |
| **Mobile app** | UX, opening the game WebView, calling **your** backend for money actions | Call integration endpoints directly or store signing secrets |
| **Game frontend** | Game UI, bet placement, Socket subscription | Invent balances or game state |

---

## How your app backend communicates

### 1. One-time setup (admin)

An operator registers your app in the game admin panel:

1. **Admin → Platform Apps** → create app  
   See [api-contract.md](./api-contract.md) §2 for `POST /admin/platform-apps`.
2. Copy fields into your backend environment:

| Field | Where it lives | Used for |
|-------|----------------|----------|
| `package_name` | Your env + every `X-App-Package` header | Identifies which app is calling |
| `signing_secret` | **App backend env only** (shown once on create/rotate) | HMAC signature |
| `sha_key` | Admin record | Android app attestation metadata only — **not** API auth |

3. Point your backend at the game platform base URL, e.g. `https://api.example.com/api/v1`.

Rate limit: **120 requests / minute / app package / IP** on all `/integrations/*` routes.

### 2. Network and transport

| Requirement | Detail |
|-------------|--------|
| Protocol | HTTPS only in production |
| Path prefix | All integration paths are under `/api/v1/integrations/...` |
| Body format | JSON (`Content-Type: application/json`) |
| Clock skew | `X-Timestamp` within **±5 minutes** of server time |
| Retries | Safe on **duplicate** `client_request_id` for credit/withdraw (idempotent replay) |
| Timeouts | Use ≥10s client timeout; retry transient 5xx with the **same** idempotency key |

Every request is authenticated **before** route handlers run. Missing or invalid signatures return **401**; disabled apps return **403**.

### 3. User identity model

Your app’s user id and the game platform’s internal id are **different**:

| Concept | Example | Where used |
|---------|---------|------------|
| `external_user_id` | `"rashed"`, `"app-user-123"` | Your app + integration API bodies/URLs |
| Platform user id (`PlatformUser.id`) | `"cmkabc123..."` (cuid) | Game wallet, bets, `X-User-Id` in dev, admin wallet search |

**Rules:**

- Always send **`external_user_id`** to integration endpoints — the platform scopes users per app via `X-App-Package`.
- On first **sync**, the platform creates `PlatformUser` + wallet (balance `0`) and returns balance in the response.
- The wallet’s `user_id` equals **`PlatformUser.id`**, not your external id.
- Store the mapping `{ external_user_id → platform_user_id }` in your backend if you need to launch the game UI (see [How the mobile app interacts](#how-the-mobile-app-interacts)).

The same email may exist under different `external_user_id` values across apps or re-registrations — treat `(app package, external_user_id)` as the unique key.

### 4. Typical server-side sequences

**Register + fund before first game session**

```text
Your app backend                          Game platform
      │                                        │
      │  POST /integrations/users/sync         │
      │  { external_user_id, email, name }     │
      │ ─────────────────────────────────────► │
      │ ◄───────────────────────────────────── │ 201/200 + balance
      │                                        │
      │  POST /integrations/users/coins        │
      │  { external_user_id, amount,           │
      │    client_request_id }                 │
      │ ─────────────────────────────────────► │
      │ ◄───────────────────────────────────── │ balance credited
      │                                        │
      │  Return launch payload to mobile app   │
      │  (platform_user_id or future token)    │
```

**After the user finishes playing**

```text
Your app backend                          Game platform
      │                                        │
      │  GET /integrations/users/:id/coins     │
      │ ─────────────────────────────────────► │
      │ ◄───────────────────────────────────── │ current balance
      │                                        │
      │  POST /integrations/users/coins/withdraw
      │  { external_user_id, amount,           │
      │    client_request_id }                 │
      │ ─────────────────────────────────────► │
      │ ◄───────────────────────────────────── │ coins removed from game wallet
      │                                        │
      │  Credit user's in-app wallet / ledger   │
```

**When to call each endpoint**

| Event in your app | Integration call |
|-------------------|------------------|
| User signs up or profile changes | `POST /integrations/users/sync` |
| User buys coins / you allocate play balance | `POST /integrations/users/coins` |
| Before showing “cash out” or leaving game | `GET .../coins` then `POST .../coins/withdraw` |
| User opens game (optional) | Ensure sync + sufficient credit already completed |

Coin conversion is **1:1**: `"500"` sent → `"500"` `COIN` in the game wallet.

### 5. Signing checklist (every request)

1. Serialize body exactly as sent (stable JSON; for GET use empty body → SHA-256 of `""`).
2. Build path **with** `/api/v1` prefix and **without** query string.
3. Compute `X-Signature` from `{timestamp}\n{METHOD}\n{path}\n{bodySha256Hex}`.
4. Send `X-App-Package` matching the registered `package_name`.
5. Log `client_request_id` on your side for support and reconciliation.

See [Authentication (HMAC)](#authentication-hmac) below for code.

### 6. Error handling on your backend

| Status | Action |
|--------|--------|
| 401 | Fix package name, clock, or signature — do not retry blindly |
| 403 | User or app disabled — surface to support |
| 404 on coins | Call **sync** first |
| 400 insufficient balance on withdraw | Refresh balance, adjust amount |
| 409 on idempotency | Bug: same `client_request_id` reused for a **different** user |
| 429 | Back off and retry |
| 5xx | Retry with same idempotency key for credit/withdraw |

---

## How the mobile app interacts

The mobile app **does not** call `/integrations/*`. It loads the **game frontend** and talks to **game player APIs** while your backend handles money.

### 1. End-to-end user journey

```text
1. User logs into your mobile app
2. Your app backend: sync user + credit coins (integration API)
3. Mobile app opens game WebView with player identity
4. Game UI: GET snapshot → user bets → Socket events update UI/wallet
5. User exits / cashes out
6. Your app backend: GET balance → withdraw (integration API) → credit in-app wallet
```

### 2. Opening the game UI

Host the game frontend URL in a WebView (or external browser for testing):

| Game | Frontend path |
|------|----------------|
| Game picker | `/` |
| Greedy | `/games/greedy` |
| Teen Patti | `/games/teen-patti` |
| Lucky 77 | `/games/lucky-77` |
| Greedy Classic | `/games/greedy-classic` |

Example production URLs:

```text
https://games.example.com/games/greedy
https://games.example.com/games/teen-patti
```

Configure the frontend build with:

```env
NEXT_PUBLIC_API_BASE_URL=https://api.example.com/api/v1
NEXT_PUBLIC_SOCKET_URL=https://api.example.com
```

Your backend CORS / Socket origin must allow the frontend origin (`CORS_ORIGIN` on the game backend).

### 3. Passing player identity (dev vs production)

**Development today**

The game backend accepts a dev-only header when `ALLOW_DEV_IDENTITY_HEADER=true`:

```http
X-User-Id: <platform_user_id>
```

The bundled game frontend sends this automatically from `NEXT_PUBLIC_DEV_USER_ID` or `?user=` query param. Use the **`PlatformUser.id`** returned implicitly after sync (wallet owner id), not `external_user_id`, unless they happen to match in your test data.

Local multi-tab test:

```text
https://localhost:3000/games/greedy?user=<platform_user_id>
```

Socket.IO uses the same identity via handshake auth:

```javascript
io(SOCKET_URL, { auth: { user_id: platformUserId } });
```

This joins the private room `user:{id}` so **`wallet.balance.updated`** events reach the correct player.

**Production (required before go-live)**

`X-User-Id` and `NEXT_PUBLIC_DEV_USER_ID` must **not** be used in production. Plan:

1. Your app backend issues a **short-lived player session** (or signed launch token) after sync.
2. Game backend player middleware validates that token on REST and Socket handshake.
3. Mobile WebView loads the game with that token (cookie, header injection, or query param — per your chosen auth design).

Player auth on the game backend is intentionally a separate step from HMAC integration auth. Integration proves **your server**; player auth proves **which user** the WebView acts as.

### 4. What the game UI calls (player API)

Once identity is established, the WebView uses REST + Socket.IO only — no integration signing.

**REST (authenticated player)**

| Action | Method | Path |
|--------|--------|------|
| Load game state | GET | `/games/{game}/snapshot` |
| Place bet | POST | `/games/{game}/bets` |
| My bet history | GET | `/games/{game}/my-bets` |
| Wallet | GET | `/wallets/me` |

Bet body (all four games):

```json
{
  "round_id": "<from snapshot>",
  "option_id": "<from snapshot>",
  "amount": "500",
  "client_request_id": "<unique per tap, 12–128 chars>"
}
```

**Socket.IO** (connect to `NEXT_PUBLIC_SOCKET_URL`)

| Event | Purpose |
|-------|---------|
| `platform.connected` | Connection ready |
| `platform.game.paused` / `resumed` | Refresh snapshot when ops pauses game |
| `greedy.round.*` / `teen_patti.round.*` / … | Round lifecycle |
| `*.bet.placed` | Other players’ public bet animations |
| `wallet.balance.updated` | Your wallet after bet/win/refund (user room) |

After major round events, the frontend **re-fetches snapshot** — treat PostgreSQL snapshot state as authoritative.

### 5. What the mobile app should implement

| Concern | Owner |
|---------|--------|
| Login, shop, in-app currency | Your app + **your** backend |
| Sync / credit / withdraw | **Your** backend → integration API |
| Display game | WebView → game frontend |
| Bet UX inside game | Game frontend → player API |
| Cash-out when leaving game | Your app → **your** backend → withdraw integration |

**Do**

- Call your own backend API from the app; let that backend call integration endpoints.
- Ensure coins are credited **before** opening the game if the user should bet immediately.
- On exit, withdraw remaining game balance back to your app economy if that is your product rule.

**Do not**

- Embed `signing_secret` in the APK/IPA.
- Call `/integrations/*` from mobile client code.
- Use raw `external_user_id` as `X-User-Id` unless it equals the platform wallet `user_id` (normally it does not).

### 6. Minimal integration example (both sides)

**App backend — fund user (Node)**

```javascript
await callIntegration({
  baseUrl: process.env.GAME_API_BASE, // e.g. https://api.example.com/api/v1
  packageName: process.env.GAME_APP_PACKAGE,
  signingSecret: process.env.GAME_SIGNING_SECRET,
  method: 'POST',
  path: '/integrations/users/sync',
  body: {
    external_user_id: user.id,
    email: user.email,
    name: user.displayName,
    photo_url: user.avatarUrl,
  },
});

await callIntegration({
  baseUrl: process.env.GAME_API_BASE,
  packageName: process.env.GAME_APP_PACKAGE,
  signingSecret: process.env.GAME_SIGNING_SECRET,
  method: 'POST',
  path: '/integrations/users/coins',
  body: {
    external_user_id: user.id,
    amount: '1000',
    client_request_id: `credit-${purchaseId}`,
  },
});

// Persist platform_user_id from your user store / sync mapping, then:
return { gameUrl: `${process.env.GAME_FRONTEND_URL}/games/greedy?user=${platformUserId}` };
```

**Mobile app — open session**

```kotlin
// Pseudocode: WebView loads URL from your backend — never embed signing secret
webView.loadUrl(launch.gameUrl)
```

For production, replace the `?user=` query param with your real player session mechanism once wired on the game backend.

---

## Response envelope

Success:

```json
{
  "statusCode": 200,
  "success": true,
  "message": "Human-readable status",
  "data": { },
  "timestamp": "2026-08-23T16:00:00.000Z"
}
```

Error:

```json
{
  "success": false,
  "statusCode": 400,
  "message": "Error description",
  "errors": { },
  "timestamp": "2026-08-23T16:00:00.000Z"
}
```

All amounts and balances are **integer strings** (no decimals), e.g. `"500"`.

---

## Authentication (HMAC)

Every request must be signed. The **signing secret** comes from admin **Platform Apps** (`/admin/apps`).  
Store it only on your app backend — never in the mobile app.

### Required headers

```text
X-App-Package: com.example.greedy
X-Timestamp: 1730000000
X-Signature: <hex-hmac-sha256>
Content-Type: application/json
```

`X-Package-Name` is accepted as an alias for `X-App-Package`.

### Signature algorithm

1. Use the path **without query string**, e.g. `/api/v1/integrations/users/sync`
2. SHA-256 hash the **raw request body** (for GET, hash an empty string)
3. Build payload:

```text
{timestamp}
{METHOD}
{path}
{bodySha256Hex}
```

4. `X-Signature = HMAC-SHA256(signing_secret, payload)` → lowercase hex
5. `X-Timestamp` must be within **5 minutes** of server time (seconds or milliseconds)

### Node.js example

```javascript
import crypto from 'crypto';

function signPlatformRequest({ signingSecret, timestamp, method, path, rawBody = '' }) {
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const payload = `${timestamp}\n${method.toUpperCase()}\n${path}\n${bodyHash}`;
  return crypto.createHmac('sha256', signingSecret).update(payload).digest('hex');
}

async function callIntegration({ baseUrl, packageName, signingSecret, method, path, body }) {
  const rawBody = body ? JSON.stringify(body) : '';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signPlatformRequest({
    signingSecret,
    timestamp,
    method,
    path: `/api/v1${path}`,
    rawBody,
  });

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-App-Package': packageName,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
    },
    ...(body ? { body: rawBody } : {}),
  });

  return response.json();
}
```

### Rotate signing secret

`POST /admin/platform-apps/:app_id/regenerate-signing-secret`  
The previous secret remains valid until the next rotation.

---

## 1. Sync user

Register or update a user scoped to your app. First sync creates a wallet with balance `0`.

```http
POST /api/v1/integrations/users/sync
```

### Request body

```json
{
  "external_user_id": "app-user-123",
  "email": "user@example.com",
  "name": "Rashid",
  "photo_url": "https://cdn.example.com/a.jpg"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `external_user_id` | Yes | Your app's user ID |
| `email` | Yes | User email |
| `name` | Yes | Display name |
| `photo_url` | No | Avatar URL (HTTPS) |

### Response

**201 Created** — new user:

```json
{
  "statusCode": 201,
  "success": true,
  "message": "Platform user created",
  "data": {
    "external_user_id": "app-user-123",
    "email": "user@example.com",
    "name": "Rashid",
    "photo_url": "https://cdn.example.com/a.jpg",
    "balance": "0",
    "currency": "COIN",
    "created": true
  },
  "timestamp": "2026-08-23T16:00:00.000Z"
}
```

**200 OK** — existing user updated:

```json
{
  "statusCode": 200,
  "success": true,
  "message": "Platform user updated",
  "data": {
    "external_user_id": "app-user-123",
    "email": "user@example.com",
    "name": "Rashid",
    "photo_url": "https://cdn.example.com/a.jpg",
    "balance": "500",
    "currency": "COIN",
    "created": false
  },
  "timestamp": "2026-08-23T16:00:00.000Z"
}
```

---

## 2. Credit coins (app → game)

Send coins into the user's game wallet. Conversion is **1:1** (send 500 → store 500).

```http
POST /api/v1/integrations/users/coins
```

### Request body

```json
{
  "external_user_id": "app-user-123",
  "amount": "500",
  "client_request_id": "purchase-uuid-001"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `external_user_id` | Yes | Your app's user ID (must be synced first) |
| `amount` | Yes | Positive integer string |
| `client_request_id` | Yes | Unique idempotency key per credit (max 128 chars) |

### Response

**200 OK** — first request:

```json
{
  "statusCode": 200,
  "success": true,
  "message": "Coins credited",
  "data": {
    "external_user_id": "app-user-123",
    "received_amount": "500",
    "converted_amount": "500",
    "balance": "500",
    "currency": "COIN",
    "idempotent": false
  },
  "timestamp": "2026-08-23T16:00:00.000Z"
}
```

**200 OK** — duplicate `client_request_id` (safe retry):

```json
{
  "statusCode": 200,
  "success": true,
  "message": "Coin credit already applied",
  "data": {
    "external_user_id": "app-user-123",
    "received_amount": "500",
    "converted_amount": "500",
    "balance": "500",
    "currency": "COIN",
    "idempotent": true
  },
  "timestamp": "2026-08-23T16:00:00.000Z"
}
```

### Errors

| Status | Message |
|--------|---------|
| 404 | Platform user not found for this app (sync first) |
| 403 | Platform user is disabled |
| 409 | `client_request_id` belongs to another user |

---

## 3. Get coin balance

```http
GET /api/v1/integrations/users/app-user-123/coins
```

No request body. Sign with an empty body hash.

### Response

**200 OK:**

```json
{
  "statusCode": 200,
  "success": true,
  "message": "Platform user balance fetched",
  "data": {
    "external_user_id": "app-user-123",
    "balance": "500",
    "currency": "COIN"
  },
  "timestamp": "2026-08-23T16:00:00.000Z"
}
```

### Errors

| Status | Message |
|--------|---------|
| 404 | Platform user not found for this app |

---

## 4. Withdraw coins (game → app)

Pull coins from the game wallet back to your app. Conversion is **1:1**.

```http
POST /api/v1/integrations/users/coins/withdraw
```

### Request body

```json
{
  "external_user_id": "app-user-123",
  "amount": "500",
  "client_request_id": "withdraw-uuid-001"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `external_user_id` | Yes | Your app's user ID |
| `amount` | Yes | Positive integer string |
| `client_request_id` | Yes | Unique idempotency key per withdrawal |

### Response

**200 OK** — success:

```json
{
  "statusCode": 200,
  "success": true,
  "message": "Coins transferred to app successfully",
  "data": {
    "external_user_id": "app-user-123",
    "requested_amount": "500",
    "transferred_amount": "500",
    "balance": "0",
    "currency": "COIN",
    "idempotent": false
  },
  "timestamp": "2026-08-23T16:00:00.000Z"
}
```

**200 OK** — duplicate `client_request_id`:

```json
{
  "statusCode": 200,
  "success": true,
  "message": "Coin withdrawal already processed",
  "data": {
    "external_user_id": "app-user-123",
    "requested_amount": "500",
    "transferred_amount": "500",
    "balance": "0",
    "currency": "COIN",
    "idempotent": true
  },
  "timestamp": "2026-08-23T16:00:00.000Z"
}
```

### Errors

**400 Insufficient balance:**

```json
{
  "success": false,
  "statusCode": 400,
  "message": "Insufficient wallet balance for withdrawal",
  "errors": {
    "balance": ["300"],
    "requested_amount": ["500"],
    "shortfall": ["200"],
    "currency": ["COIN"]
  },
  "timestamp": "2026-08-23T16:00:00.000Z"
}
```

| Status | Message |
|--------|---------|
| 404 | Platform user not found for this app |
| 403 | Platform user is disabled |
| 409 | `client_request_id` belongs to another user |

---

## Common auth errors

| Status | Message |
|--------|---------|
| 401 | Platform integration requires X-App-Package, X-Timestamp, and X-Signature headers |
| 401 | Invalid platform request signature |
| 401 | Platform request timestamp is expired or too far in the future |
| 401 | Unknown platform app package |
| 403 | Platform app is disabled |
| 429 | Too many integration requests |

---

## Example journey

```text
1. POST /integrations/users/sync
   → balance: "0", created: true

2. POST /integrations/users/coins  { amount: "1000", client_request_id: "buy-001" }
   → balance: "1000"

3. GET /integrations/users/app-user-123/coins
   → balance: "1000"

4. POST /integrations/users/coins/withdraw  { amount: "400", client_request_id: "wd-001" }
   → transferred_amount: "400", balance: "600"
```

---

## Setup checklist

### App backend (integration)

1. Create app in admin panel → **Platform Apps** (`/admin/apps`)
2. Copy `signing_secret` into app backend env (shown once on create or rotate)
3. Set `package_name` to match `X-App-Package` header
4. Implement HMAC signing on every integration request ([How your app backend communicates](#how-your-app-backend communicates))
5. Store `external_user_id` ↔ `PlatformUser.id` mapping after sync
6. Call endpoints in order: **sync** before coins / balance / withdraw
7. Use unique `client_request_id` per credit and withdrawal

### Mobile app + game UI

1. Deploy or host the game frontend with correct `NEXT_PUBLIC_API_BASE_URL` and `NEXT_PUBLIC_SOCKET_URL`
2. Set game backend `CORS_ORIGIN` to the frontend origin
3. From the app, open game URLs in WebView after your backend has synced and credited the user
4. For local dev only: `ALLOW_DEV_IDENTITY_HEADER=true` and pass `PlatformUser.id` via `X-User-Id` / `?user=`
5. Before production: replace dev `X-User-Id` with real player session auth ([How the mobile app interacts](#how-the-mobile-app-interacts) §3)

### Ops

1. Resume game runtimes in admin after seed/deploy
2. Run the game **worker** process alongside the API server
3. Monitor integration **429** rate limits and signing **401** errors in your app backend logs
