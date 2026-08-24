# Platform App Integration API

**Base path:** `/api/v1`  
**Auth:** public. Every request must send `app_name`, `package_name`, and `sha_key`.

## How the app connects a user (required flow)

```text
1. POST /integrations/users/sync     → creates/updates user, returns user_id + launch_url
2. POST /integrations/users/coins    → credit coins (optional before play)
3. Open WebView with data.launch_url → home page already has player identity
4. User taps any game                → works (identity kept in the WebView session)
```

`launch_url` looks like:

```text
https://game.maxlived.net/?user=<platform_user_id>
```

Open that **once** when entering games. Do **not** attach user id on every game click.

Server env must set:

```env
GAME_FRONTEND_URL=https://game.maxlived.net
```

---

## 1. Sync user

```http
POST /api/v1/integrations/users/sync
```

### Body

```json
{
  "app_name": "Greedy Live",
  "package_name": "com.example.greedy",
  "sha_key": "AABBCCDDEEFF00112233445566778899AABBCCDD",
  "external_user_id": "app-user-123",
  "email": "user@example.com",
  "name": "Rashid",
  "photo_url": "https://cdn.example.com/a.jpg"
}
```

### Response

```json
{
  "statusCode": 201,
  "success": true,
  "message": "Platform user created",
  "data": {
    "user_id": "cmkabc123platformuserid",
    "external_user_id": "app-user-123",
    "email": "user@example.com",
    "name": "Rashid",
    "photo_url": "https://cdn.example.com/a.jpg",
    "balance": "0",
    "currency": "COIN",
    "created": true,
    "launch_url": "https://game.maxlived.net/?user=cmkabc123platformuserid"
  },
  "timestamp": "2026-08-23T16:00:00.000Z"
}
```

Flutter: open WebView with `data.launch_url`.

---

## 2. Credit coins

```http
POST /api/v1/integrations/users/coins
```

### Body

```json
{
  "app_name": "Greedy Live",
  "package_name": "com.example.greedy",
  "sha_key": "AABBCCDDEEFF00112233445566778899AABBCCDD",
  "external_user_id": "app-user-123",
  "amount": "500",
  "client_request_id": "purchase-uuid-001"
}
```

### Response

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

---

## 3. Get coin balance

```http
GET /api/v1/integrations/users/app-user-123/coins?app_name=Greedy%20Live&package_name=com.example.greedy&sha_key=AABBCCDDEEFF00112233445566778899AABBCCDD
```

### Response

```json
{
  "statusCode": 200,
  "success": true,
  "message": "Platform user balance fetched",
  "data": {
    "user_id": "cmkabc123platformuserid",
    "external_user_id": "app-user-123",
    "balance": "500",
    "currency": "COIN",
    "launch_url": "https://game.maxlived.net/?user=cmkabc123platformuserid"
  },
  "timestamp": "2026-08-23T16:00:00.000Z"
}
```

---

## 4. Withdraw coins

```http
POST /api/v1/integrations/users/coins/withdraw
```

### Body

```json
{
  "app_name": "Greedy Live",
  "package_name": "com.example.greedy",
  "sha_key": "AABBCCDDEEFF00112233445566778899AABBCCDD",
  "external_user_id": "app-user-123",
  "amount": "500",
  "client_request_id": "withdraw-uuid-001"
}
```

### Response

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

---

## Optional: launch redirect

If the app prefers not to build the game URL itself:

```http
GET /api/v1/integrations/users/launch?app_name=Greedy%20Live&package_name=com.example.greedy&sha_key=...&external_user_id=app-user-123&path=/
```

→ **302** to `https://game.maxlived.net/?user=<user_id>`
