# Game Platform API — Postman

Complete production REST collection covering **every** `/api/v1` HTTP route (189 endpoints).

## Files

| File | Purpose |
| --- | --- |
| `Game_Platform_API.postman_collection.json` | Full API collection |
| `Game_Platform_Production.postman_environment.json` | Production environment |

## Import

1. Import both files into Postman
2. Select **Game Platform Production**
3. Set `admin_email` / `admin_password` (seed defaults: `superadmin@example.com` / `SuperAdminPassword123` unless overridden by env)
4. Run **01 — Admin Auth → Admin Login** first — stores Bearer `admin_session_token`

## Base URL

```
https://game-api.maxlived.net/api/v1
```

## Collection map

| Folder | Coverage |
| --- | --- |
| 00 — Health | live / ready |
| 01 — Admin Auth | login, me, logout, password, sessions |
| 02 — Admin Users & Policy | admin-users CRUD-ish, policy |
| 03 — Approvals | list / get / approve / reject |
| 04 — Analytics | overview, users, user detail |
| 05 — Platform Apps | CRUD + regenerate signing secret |
| 06 — Platform Users | search, detail, ledger, app filter |
| 07 — Wallets | player wallet + admin search/adjust |
| 08 — Integrations | sync, coins credit/withdraw, launch, balance |
| 09–12 — Games | Player + Admin (lifecycle, config, ops, assets, rounds) for Greedy, Greedy Classic, Lucky 77, Teen Patti |

## Auth

| Surface | Headers |
| --- | --- |
| Admin | `Authorization: Bearer {{admin_session_token}}` |
| Admin mutations | also `Idempotency-Key: {{$guid}}` |
| Player | `X-User-Id: {{user_id}}` when the deployment allows the identity header |
| Integrations | coins credit/withdraw: `X-App-Name`, `X-Package-Name`, `X-Sha-Key` headers; sync/launch/balance: credentials in body/query |


## Secrets

Do not commit real passwords, session tokens, or signing secrets.
