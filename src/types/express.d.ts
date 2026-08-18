declare global {
  namespace Express {
    interface Request {
      game_user_id?: string;
      request_id?: string;
    }
  }
}

export {};
