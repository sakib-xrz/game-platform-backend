import type { AdminRole, AdminStatus } from '@/generated/prisma/client';

export type AuthenticatedAdmin = {
  id: string;
  email: string;
  display_name: string;
  role: AdminRole;
  status: AdminStatus;
  force_password_change: boolean;
};

