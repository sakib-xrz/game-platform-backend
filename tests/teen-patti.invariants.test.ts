import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AdminApprovalStatus,
  ConfigVersionStatus,
} from '@/generated/prisma/client';
import TeenPattiAdminService from '@/modules/game-admin/teen-patti-admin.services';
import {
  effectiveTeenPattiResultDurationMs,
  getTeenPattiPublishInvariantFailures,
} from '@/modules/teen-patti/teen-patti.config';

const mocks = vi.hoisted(() => {
  const tx = {
    game: { findUnique: vi.fn() },
    teenPattiConfigVersion: {
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    adminApprovalRequest: { findUnique: vi.fn() },
    teenPattiRuntimeState: { update: vi.fn() },
  };
  return {
    tx,
    createPendingApproval: vi.fn(),
    markApprovalApplied: vi.fn(),
    verifyApprovalPayloadHash: vi.fn(),
    writeAdminAudit: vi.fn(),
  };
});

vi.mock('@/lib/prisma', () => ({
  default: {
    $transaction: async <T>(
      operation: (tx: typeof mocks.tx) => Promise<T>,
    ): Promise<T> => operation(mocks.tx),
  },
}));

vi.mock('@/modules/admin/admin-approval.services', () => ({
  createPendingApproval: mocks.createPendingApproval,
  markApprovalApplied: mocks.markApprovalApplied,
  verifyApprovalPayloadHash: mocks.verifyApprovalPayloadHash,
}));

vi.mock('@/modules/admin/admin.services', () => ({
  writeAdminAudit: mocks.writeAdminAudit,
}));

const storedConfig = () => ({
  id: 'config-1',
  game_id: 'teen-game',
  version: 1,
  status: ConfigVersionStatus.draft as ConfigVersionStatus,
  result_duration_ms: 5_000,
  min_bet: 100n,
  max_single_bet: 5_000n,
  max_round_bet: 10_000n,
  options: [
    { id: 'hand-a', is_enabled: true },
    { id: 'hand-b', is_enabled: true },
    { id: 'hand-c', is_enabled: true },
  ],
  chip_values: [
    { id: 'chip-100', amount: 100n, is_enabled: true },
    { id: 'chip-500', amount: 500n, is_enabled: true },
  ],
});

describe('Teen Patti stored config invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.game.findUnique.mockResolvedValue({ id: 'teen-game' });
  });

  it('accepts a valid stored config and clamps legacy result timing', () => {
    expect(getTeenPattiPublishInvariantFailures(storedConfig())).toEqual([]);
    expect(effectiveTeenPattiResultDurationMs(1_000)).toBe(5_000);
    expect(effectiveTeenPattiResultDurationMs(7_500)).toBe(7_500);
  });

  it('reports option, enabled-chip, duration, and denomination failures', () => {
    const structurally_invalid = storedConfig();
    structurally_invalid.options[2]!.is_enabled = false;
    structurally_invalid.chip_values.forEach((chip) => {
      chip.is_enabled = false;
    });
    structurally_invalid.result_duration_ms = 4_999;

    expect(getTeenPattiPublishInvariantFailures(structurally_invalid)).toEqual([
      expect.objectContaining({ field: 'options' }),
      expect.objectContaining({ field: 'chip_values' }),
      expect.objectContaining({ field: 'result_duration_ms' }),
    ]);

    const invalid_denominations = storedConfig();
    invalid_denominations.chip_values = [
      { id: 'chip-low', amount: 99n, is_enabled: true },
      { id: 'chip-high', amount: 5_001n, is_enabled: true },
    ];
    expect(
      getTeenPattiPublishInvariantFailures(invalid_denominations),
    ).toEqual([
      expect.objectContaining({
        field: 'chip_values',
        message: 'every enabled chip must be between min_bet and max_single_bet',
      }),
    ]);
  });

  it('rejects an invalid draft before requesting publish approval', async () => {
    const target = storedConfig();
    target.result_duration_ms = 4_999;
    mocks.tx.teenPattiConfigVersion.findFirst.mockResolvedValue(target);

    await expect(
      TeenPattiAdminService.requestPublishConfig('config-1', {
        admin_user_id: 'admin-1',
        idempotency_key: 'publish-request-1',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('result_duration_ms must be at least 5000'),
    });

    expect(mocks.createPendingApproval).not.toHaveBeenCalled();
    expect(mocks.tx.teenPattiConfigVersion.update).not.toHaveBeenCalled();
  });

  it('revalidates review-pending rows before applying an approval', async () => {
    const target = storedConfig();
    target.status = ConfigVersionStatus.review_pending;
    target.chip_values = [
      { id: 'chip-invalid', amount: 50n, is_enabled: true },
    ];
    mocks.tx.adminApprovalRequest.findUnique.mockResolvedValue({
      id: 'approval-1',
      action_type: 'teen_patti.config.publish',
      requested_by_admin_id: 'admin-1',
      status: AdminApprovalStatus.approved,
      expires_at: new Date(Date.now() + 60_000),
      payload: { config_id: target.id },
      payload_hash: 'verified-by-mock',
      decisions: [],
    });
    mocks.tx.teenPattiConfigVersion.findFirst.mockResolvedValue(target);

    await expect(
      TeenPattiAdminService.publishApprovedConfig('approval-1', {
        admin_user_id: 'admin-1',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(
        'every enabled chip must be between min_bet and max_single_bet',
      ),
    });

    expect(mocks.tx.teenPattiConfigVersion.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.teenPattiRuntimeState.update).not.toHaveBeenCalled();
    expect(mocks.markApprovalApplied).not.toHaveBeenCalled();
  });
});
