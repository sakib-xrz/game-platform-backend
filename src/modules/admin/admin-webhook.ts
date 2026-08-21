import crypto from 'node:crypto';
import config from '@/config';
import { canonicalJson } from '@/utils/hash';

export type OpsWebhookPayload = {
  event_id: string;
  source: 'greedy-ops' | 'teen-patti-ops' | 'lucky-77-ops';
  code: string;
  severity: 'warning' | 'critical';
  message: string;
  metadata: Record<string, unknown>;
  occurred_at: string;
};

export const signOpsWebhook = (timestamp: string, body: string, secret: string): string =>
  `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Delivers a canonical, HMAC-signed operations event with bounded retries. */
export const deliverOpsWebhook = async (payload: OpsWebhookPayload): Promise<'delivered' | 'disabled'> => {
  if (!config.ops_alert_webhook_url) return 'disabled';
  if (!config.ops_alert_webhook_secret) throw new Error('OPS_ALERT_WEBHOOK_SECRET is required when the operations webhook is enabled');
  const body = canonicalJson(payload);
  const attempts = Math.min(8, Math.max(1, config.ops_alert_webhook_max_attempts));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    try {
      const response = await fetch(config.ops_alert_webhook_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-greedy-event-id': payload.event_id,
          'x-greedy-timestamp': timestamp,
          'x-greedy-signature': signOpsWebhook(timestamp, body, config.ops_alert_webhook_secret),
        },
        body,
        signal: AbortSignal.timeout(config.ops_alert_webhook_timeout_ms),
      });
      if (!response.ok) throw new Error(`Operations webhook returned HTTP ${response.status}`);
      return 'delivered';
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(Math.min(4000, 250 * (2 ** (attempt - 1))));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Operations webhook delivery failed'));
};
