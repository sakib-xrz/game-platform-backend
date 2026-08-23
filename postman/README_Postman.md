# Greedy Game Postman setup

1. Import `Greedy_Game_API.postman_collection.json` and `Greedy_Game_Local.postman_environment.json` into Postman.
2. Select the **Greedy Game Local** environment.
3. Set `admin_api_key` to the same value as `ADMIN_API_KEY` in your local `.env` file. Keep it secret; it is intentionally not committed as a real credential.
4. Start PostgreSQL and Redis, deploy the existing migrations, apply hardening, seed the database, and start the API plus worker:

   ```bash
   docker compose up -d
   npm ci
   npm run prisma:generate
   npm run prisma:deploy
   npm run prisma:harden
   npm run prisma:seed
   npm run dev
   ```

   In another terminal:

   ```bash
   npm run dev:worker
   ```

5. Run the collection from health checks through the Greedy lifecycle. The collection stores generated IDs and state in its collection variables; the environment contains only stable local defaults.

For a clean local database, remove the named Docker volume only when you intentionally want to discard all local data.

## Lucky 77

1. Import `Lucky_77_Game_API.postman_collection.json` and `Lucky_77_Game_Local.postman_environment.json`.
2. Select **Lucky 77 Game Local**. Seed admin defaults: `admin@example.com` / `AdminPassword123`.
3. Run **Admin Login** first (stores Bearer `admin_session_token`).
4. Flow: Resume Lucky 77 → Snapshot → Credit Wallet (amount ≤ 9999) → Place Bet (expects **201**) → My Bets / Round Detail.
5. Snapshot asserts `slot_map` length 9; round detail captures `winning_slot_index`.

## Greedy Classic

1. Import `Greedy_Classic_Game_API.postman_collection.json` and `Greedy_Classic_Game_Local.postman_environment.json`.
2. Select **Greedy Classic Game Local**. Seed admin defaults: `admin@example.com` / `AdminPassword123`.
3. Run **Admin Login** first (stores Bearer `admin_session_token`).
4. Flow: Resume Greedy Classic → Snapshot → Credit Wallet → Place Bet (expects **201**) → My Bets / Round Detail.
