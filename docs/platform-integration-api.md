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

1. Create app in admin panel → **Platform Apps** (`/admin/apps`)
2. Copy `signing_secret` into app backend env (shown once on create or rotate)
3. Set `package_name` to match `X-App-Package` header
4. Implement HMAC signing on every request
5. Call endpoints in order: sync before coins/balance/withdraw
