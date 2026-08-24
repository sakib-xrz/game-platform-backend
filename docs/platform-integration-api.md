# Platform App Integration API

**Base path:** `/api/v1`  
**Auth:** public. Every request must send `app_name`, `package_name`, and `sha_key`. All three must match an active Platform App or the request is rejected.

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

| Field | Required |
|-------|----------|
| `app_name` | Yes |
| `package_name` | Yes |
| `sha_key` | Yes |
| `external_user_id` | Yes |
| `email` | Yes |
| `name` | Yes |
| `photo_url` | No |

### Response

**201** — created:

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

**200** — updated:

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

| Field | Required |
|-------|----------|
| `app_name` | Yes |
| `package_name` | Yes |
| `sha_key` | Yes |
| `external_user_id` | Yes |
| `amount` | Yes |
| `client_request_id` | Yes |

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

Duplicate `client_request_id` returns the same shape with `"idempotent": true` and message `"Coin credit already applied"`.

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
    "external_user_id": "app-user-123",
    "balance": "500",
    "currency": "COIN"
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

| Field | Required |
|-------|----------|
| `app_name` | Yes |
| `package_name` | Yes |
| `sha_key` | Yes |
| `external_user_id` | Yes |
| `amount` | Yes |
| `client_request_id` | Yes |

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

Duplicate `client_request_id` returns the same shape with `"idempotent": true` and message `"Coin withdrawal already processed"`.
