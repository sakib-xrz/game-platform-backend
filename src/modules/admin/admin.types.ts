import type { AdminRole, AdminStatus } from '@/generated/prisma/client';

export type AuthenticatedAdmin = {
  id: string;
  email: string;
  display_name: string;
  role: AdminRole;
  status: AdminStatus;
  force_password_change: boolean;
  platform_app_id?: string | null;
  platform_app?: {
    id: string;
    app_name: string;
    package_name: string;
  } | null;
};

