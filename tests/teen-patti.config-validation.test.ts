import { describe, expect, it } from 'vitest';
import { createTeenPattiConfigSchema } from '@/modules/game-admin/game-admin.validation';

const validBody = () => ({
  betting_duration_ms: 15_000,
  lock_duration_ms: 1_500,
  drawing_duration_ms: 5_500,
  result_duration_ms: 5_000,
  min_bet: '100',
  max_single_bet: '5000',
  max_round_bet: '10000',
  rake_bps: 500,
  chip_values: [
    { amount: '100', display_order: 1, is_enabled: true },
    { amount: '500', display_order: 2, is_enabled: true },
    { amount: '50', display_order: 3, is_enabled: false },
  ],
  options: [
    { code: 'DECK_A', name: 'Hand A', image_url: null, asset_id: null, display_order: 1, is_enabled: true },
    { code: 'DECK_B', name: 'Hand B', image_url: null, asset_id: null, display_order: 2, is_enabled: true },
    { code: 'DECK_C', name: 'Hand C', image_url: null, asset_id: null, display_order: 3, is_enabled: true },
  ],
});

describe('Teen Patti config validation', () => {
  it('allows disabled chips outside the bet limits', () => {
    expect(createTeenPattiConfigSchema.safeParse({ body: validBody() }).success).toBe(true);
  });

  it('rejects enabled chips outside min_bet and max_single_bet', () => {
    const body = validBody();
    body.chip_values = [
      { amount: '50', display_order: 1, is_enabled: true },
      { amount: '10000', display_order: 2, is_enabled: true },
    ];

    const result = createTeenPattiConfigSchema.safeParse({ body });
    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['body', 'chip_values', 0, 'amount'],
          message: 'Enabled chip amount must be between min_bet and max_single_bet',
        }),
        expect.objectContaining({
          path: ['body', 'chip_values', 1, 'amount'],
          message: 'Enabled chip amount must be between min_bet and max_single_bet',
        }),
      ]),
    );
  });

  it('keeps the result window long enough for reveal, payout, and result UI', () => {
    const body = validBody();
    body.result_duration_ms = 4_999;

    const result = createTeenPattiConfigSchema.safeParse({ body });
    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['body', 'result_duration_ms'],
          code: 'too_small',
        }),
      ]),
    );
  });
});
