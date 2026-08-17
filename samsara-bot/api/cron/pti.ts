import type { VercelRequest, VercelResponse } from '@vercel/node';
import { dispatchAlerts } from '../../src/alerts';
import { failed, requireAuthorized } from '../../src/guard';
import { log } from '../../src/logger';
import { buildPtiReport } from '../../src/reports';
import { notifyDefaultChat } from '../../src/telegram/api';

/**
 * Daily pre-trip inspection compliance report, plus individual alerts for any
 * DVIR that came back unsafe or carries open defects.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireAuthorized(req, res)) return;

  try {
    const report = await buildPtiReport(new Date());
    const delivered = await notifyDefaultChat(report.text);
    const alertResult = await dispatchAlerts(report.alerts);

    log.info('PTI report sent', { delivered, ...alertResult });
    res.status(200).json({ ok: delivered, delivered, alerts: alertResult });
  } catch (error) {
    failed(res, error, 'PTI report');
  }
}
