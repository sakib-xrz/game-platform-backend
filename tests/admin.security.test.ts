import { describe, expect, it } from 'vitest';
import { AdminRole } from '@/generated/prisma/client';
import { hashAdminPassword, verifyAdminPassword, createSessionToken, hashSessionToken } from '@/modules/admin/admin.crypto';
import { hasAdminPermission } from '@/modules/admin/admin.permissions';
import { canAdminApprove, verifyApprovalPayloadHash } from '@/modules/admin/admin-approval.services';
import { loginSchema, updatePolicySchema } from '@/modules/admin/admin.validation';
import { canonicalJson, sha256, stableRequestHash } from '@/utils/hash';

describe('admin security primitives', () => {
  it('uses Argon2id-compatible password hashes and rejects the wrong password', async () => {
    const password = 'correct horse battery staple';
    const hashed = await hashAdminPassword(password);

    expect(hashed).toMatch(/^\$argon2id\$/);
    await expect(verifyAdminPassword(hashed, password)).resolves.toBe(true);
    await expect(verifyAdminPassword(hashed, 'incorrect password')).resolves.toBe(false);
    expect(hashed).not.toContain(password);
  });

  it('stores only a deterministic digest for opaque bearer tokens', () => {
    const first = createSessionToken();
    const second = createSessionToken();

    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(40);
    expect(hashSessionToken(first)).toBe(hashSessionToken(first));
    expect(hashSessionToken(first)).not.toBe(first);
    expect(hashSessionToken(first)).toBe(sha256(first));
  });

  it('enforces the five-role permission boundary', () => {
    expect(hasAdminPermission(AdminRole.super_admin, 'admin.manage')).toBe(true);
    expect(hasAdminPermission(AdminRole.game_operator, 'game.runtime.control')).toBe(true);
    expect(hasAdminPermission(AdminRole.game_operator, 'wallet.adjust.create')).toBe(false);
    expect(hasAdminPermission(AdminRole.finance_operator, 'wallet.adjust.approve')).toBe(true);
    expect(hasAdminPermission(AdminRole.finance_operator, 'game.config.publish')).toBe(false);
    expect(hasAdminPermission(AdminRole.support, 'wallet.read')).toBe(true);
    expect(hasAdminPermission(AdminRole.support, 'wallet.adjust.create')).toBe(false);
    expect(hasAdminPermission(AdminRole.auditor, 'audit.read')).toBe(true);
    expect(hasAdminPermission(AdminRole.auditor, 'audit.export' as never)).toBe(false);
  });

  it('requires a distinct eligible approver for each approval class', () => {
    expect(canAdminApprove('wallet.adjust', AdminRole.finance_operator, 'requester', 'finance')).toBe(true);
    expect(canAdminApprove('wallet.adjust', AdminRole.game_operator, 'requester', 'game')).toBe(false);
    expect(canAdminApprove('greedy.config.publish', AdminRole.game_operator, 'requester', 'game')).toBe(true);
    expect(canAdminApprove('greedy.config.publish', AdminRole.finance_operator, 'requester', 'finance')).toBe(false);
    expect(canAdminApprove('greedy.config.publish', AdminRole.super_admin, 'same', 'same')).toBe(false);
    expect(canAdminApprove('teen_patti.config.publish', AdminRole.game_operator, 'requester', 'game')).toBe(true);
    expect(canAdminApprove('teen_patti.config.publish', AdminRole.finance_operator, 'requester', 'finance')).toBe(false);
    expect(canAdminApprove('teen_patti.round.cancel', AdminRole.game_operator, 'requester', 'ops')).toBe(true);
  });

  it('rejects tampered approval payloads', () => {
    const payload = { user_id: 'user-001', amount: '5000', reason: 'test' };
    const digest = sha256(JSON.stringify(payload));

    expect(() => verifyApprovalPayloadHash(payload, digest)).not.toThrow();
    expect(() => verifyApprovalPayloadHash({ ...payload, amount: '50000' }, digest)).toThrow(/integrity/);
  });

  it('canonicalizes nested request and approval payloads independent of key order', () => {
    const first = { body: { user_id: 'u-1', amount: '10000', nested: { reason: 'support', ticket: 'T-1' } }, method: 'POST' };
    const second = { method: 'POST', body: { nested: { ticket: 'T-1', reason: 'support' }, amount: '10000', user_id: 'u-1' } };
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(stableRequestHash(first)).toBe(stableRequestHash(second));
    expect(() => verifyApprovalPayloadHash(second.body, sha256(canonicalJson(first.body)))).not.toThrow();
  });

  it('normalizes login email and rejects invalid policy thresholds', () => {
    const parsed = loginSchema.parse({ body: { email: ' Admin@Example.COM ', password: 'a sufficiently long password' } });
    expect(parsed.body.email).toBe('admin@example.com');
    expect(() => updatePolicySchema.parse({ body: { wallet_adjustment_threshold: '-1', approval_expiry_minutes: 1440 } })).toThrow();
  });
});
