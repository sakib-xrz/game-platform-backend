import 'dotenv/config';
import { AdminRole, AdminStatus } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { ensureStrongPassword } from '@/modules/admin/admin.services';
import { hashAdminPassword, normalizeAdminEmail } from '@/modules/admin/admin.crypto';

type Args = Record<string, string | undefined>;

const readHidden = async (prompt: string): Promise<string> => {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('Interactive password input requires a TTY; use ADMIN_BOOTSTRAP_PASSWORD only for deliberate non-interactive automation');
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          process.stdin.setRawMode?.(false);
          process.stdin.off('data', onData);
          reject(new Error('Password input cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          process.stdin.setRawMode?.(false);
          process.stdin.off('data', onData);
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    process.stdin.on('data', onData);
  });
};

const args = (values: string[]): Args => {
  const result: Args = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value?.startsWith('--')) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    result[key] = next && !next.startsWith('--') ? next : 'true';
    if (result[key] !== 'true') index += 1;
  }
  return result;
};

const required = (parsed: Args, key: string): string => {
  const value = parsed[key]?.trim();
  if (!value) throw new Error(`Missing --${key}`);
  return value;
};

const main = async (): Promise<void> => {
  const [command] = process.argv.slice(2);
  const parsed = args(process.argv.slice(3));
  const email = normalizeAdminEmail(required(parsed, 'email'));
  let password = parsed.password || process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!password) {
    password = await readHidden('Password: ');
    const confirmation = await readHidden('Confirm password: ');
    if (password !== confirmation) throw new Error('Passwords do not match');
  }
  ensureStrongPassword(password);

  if (command === 'bootstrap') {
    const existing = await prisma.adminUser.count({ where: { role: AdminRole.super_admin } });
    if (existing > 0) throw new Error('A super admin already exists; use recover instead');
    const password_hash = await hashAdminPassword(password);
    const created = await prisma.adminUser.create({
      data: {
        email,
        display_name: parsed['display-name']?.trim() || 'Platform Administrator',
        role: AdminRole.super_admin,
        status: AdminStatus.active,
        password_hash,
        force_password_change: true,
      },
      select: { id: true, email: true, role: true },
    });
    await prisma.adminPolicy.upsert({ where: { code: 'default' }, create: {}, update: {} });
    console.log(JSON.stringify({ created: true, admin: created }));
    return;
  }

  if (command === 'recover') {
    const target = await prisma.adminUser.findUnique({ where: { email }, select: { id: true } });
    if (!target) throw new Error('Admin user not found');
    const password_hash = await hashAdminPassword(password);
    await prisma.$transaction([
      prisma.adminUser.update({ where: { id: target.id }, data: { password_hash, force_password_change: true, failed_login_count: 0, locked_until: null, status: AdminStatus.active, password_changed_at: new Date() } }),
      prisma.adminSession.updateMany({ where: { admin_user_id: target.id, revoked_at: null }, data: { revoked_at: new Date() } }),
    ]);
    console.log(JSON.stringify({ recovered: true, email }));
    return;
  }

  throw new Error('Usage: admin.ts bootstrap|recover --email <email> --password <password> [--display-name <name>]');
};

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
