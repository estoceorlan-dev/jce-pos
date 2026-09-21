import { statfs } from 'node:fs/promises';
import type pg from 'pg';
import type { Logger } from 'pino';

export async function storageSnapshot(
  pool: pg.Pool,
  volumePath?: string,
  minimumFreeBytes = 5 * 1024 ** 3,
) {
  const result = await pool.query<{
    database_bytes: string;
    outbox_bytes: string;
    pending_events: string;
    oldest_pending_at: Date | null;
  }>(`SELECT pg_database_size(current_database())::text AS database_bytes,
    pg_total_relation_size('public.sync_queue')::text AS outbox_bytes,
    (SELECT count(*)::text FROM sync_queue WHERE status='pending') AS pending_events,
    (SELECT min(created_at) FROM sync_queue WHERE status='pending') AS oldest_pending_at`);
  const row = result.rows[0]!;
  let freeBytes: bigint | null = null;
  if (volumePath) {
    const disk = await statfs(volumePath, { bigint: true });
    freeBytes = disk.bavail * disk.bsize;
  }
  return {
    databaseBytes: row.database_bytes,
    outboxBytes: row.outbox_bytes,
    pendingEvents: row.pending_events,
    oldestPendingAt: row.oldest_pending_at?.toISOString() ?? null,
    freeBytes: freeBytes?.toString() ?? null,
    lowDisk: freeBytes === null ? null : freeBytes < BigInt(minimumFreeBytes),
  };
}
/** Read-only local monitoring; no retention job deletes business data or unsent events. */
export function monitorStorage(
  pool: pg.Pool,
  logger: Logger,
  volumePath: string | undefined,
  minimumFreeBytes: number,
) {
  let busy = false;
  let stopped = false;
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      const snapshot = await storageSnapshot(
        pool,
        volumePath,
        minimumFreeBytes,
      );
      if (snapshot.lowDisk)
        logger.warn(
          { code: 'LOW_DISK_SPACE', ...snapshot },
          'Storage requires attention',
        );
      else
        logger.info(
          {
            code: volumePath ? 'STORAGE_STATUS' : 'DISK_MONITOR_NOT_CONFIGURED',
            ...snapshot,
          },
          'Local storage status',
        );
    } catch {
      logger.warn(
        { code: 'STORAGE_MONITOR_UNAVAILABLE' },
        'Storage status could not be measured',
      );
    } finally {
      busy = false;
    }
  }
  void tick();
  const timer = setInterval(() => void tick(), 60000).unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
