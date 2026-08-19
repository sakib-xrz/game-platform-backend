import { logger } from '@/utils/logger';
import GreedyOpsService from '@/modules/game-admin/greedy-admin-ops.services';
import TeenPattiOpsService from '@/modules/game-admin/teen-patti-admin-ops.services';

let timer: NodeJS.Timeout | null = null;
let running = false;

export const refreshOpsAlerts = async (): Promise<void> => {
  if (running) return;
  running = true;
  try {
    await GreedyOpsService.refreshOperationalAlerts();
    await TeenPattiOpsService.refreshOperationalAlerts();
  }
  catch (error) { logger.warn('ops_alert_refresh_failed', { error }); }
  finally { running = false; }
};

export const startOpsAlertWorker = (): void => {
  if (timer) return;
  timer = setInterval(() => void refreshOpsAlerts(), 30_000);
  void refreshOpsAlerts();
};

export const stopOpsAlertWorker = (): void => {
  if (timer) clearInterval(timer);
  timer = null;
};
