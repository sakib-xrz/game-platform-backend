-- AlterTable
ALTER TABLE "game_bots" ADD COLUMN "game_code" TEXT NOT NULL DEFAULT 'LEGACY';

-- CreateIndex
CREATE INDEX "game_bots_game_code_status_idx" ON "game_bots"("game_code", "status");
