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
