declare global {
  namespace Express {
    interface AuthenticatedAdminContext {
      id: string;
      email: string;
      display_name: string;
      role: import('@/generated/prisma/client').AdminRole;
      status: import('@/generated/prisma/client').AdminStatus;
      force_password_change: boolean;
    }

    interface Request {
      game_user_id?: string;
      request_id?: string;
      admin?: AuthenticatedAdminContext;
      admin_session_id?: string;
      platform_app?: import('@/middlewares/platform-app-auth').AuthenticatedPlatformApp;
    }
  }
}

export {};
