import argon2 from 'argon2';
import crypto from 'node:crypto';
import { sha256 } from '@/utils/hash';

export const hashAdminPassword = (password: string): Promise<string> =>
  argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

export const verifyAdminPassword = (hash: string, password: string): Promise<boolean> =>
  argon2.verify(hash, password);

export const createSessionToken = (): string => crypto.randomBytes(32).toString('base64url');

export const hashSessionToken = (token: string): string => sha256(token);

export const normalizeAdminEmail = (email: string): string => email.trim().toLowerCase();
