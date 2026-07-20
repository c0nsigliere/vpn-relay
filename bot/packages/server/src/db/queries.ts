import { db } from "./index";
import { env } from "../config/env";
import type { Client, TrafficSnapshot, TrafficTotals, ServerTrafficSnapshot, MonthlyTraffic, DailyTraffic, AlertSetting, MaintenanceJob, ServerId, BackupRun, BackupStatus, BackupTrigger } from "@vpn-relay/shared";

export type { Client, TrafficSnapshot, TrafficTotals, ServerTrafficSnapshot, MonthlyTraffic, DailyTraffic, AlertSetting, MaintenanceJob, BackupRun, BackupStatus, BackupTrigger };

export interface AlertState {
  alert_key: string;
  status: "fired" | "clear";
  fired_at: string | null;
  cleared_at: string | null;
  context: string | null;
}

/** Convert "+3:00" → "+3 hours", "-5:00" → "-5 hours" for SQLite datetime modifier */
function tzModifier(): string {
  const match = env.TZ_OFFSET.match(/^([+-]\d+):/);
  return match ? `${match[1]} hours` : "+0 hours";
}

export const queries = {
  getAllClients(): Client[] {
    return db.prepare("SELECT * FROM clients ORDER BY created_at DESC").all() as Client[];
  },

  getClientById(id: string): Client | undefined {
    return db.prepare("SELECT * FROM clients WHERE id = ?").get(id) as Client | undefined;
  },

  getClientByName(name: string): Client | undefined {
    return db.prepare("SELECT * FROM clients WHERE name = ?").get(name) as Client | undefined;
  },

  insertClient(client: Omit<Client, "created_at" | "last_seen_at" | "last_ip" | "last_ip_isp" | "last_connection_route">): void {
    db.prepare(`
      INSERT INTO clients (id, name, type, wg_ip, wg_pubkey, xray_uuid, hy2_password, expires_at, is_active, daily_quota_gb, monthly_quota_gb, wg_cascade_transport)
      VALUES (@id, @name, @type, @wg_ip, @wg_pubkey, @xray_uuid, @hy2_password, @expires_at, @is_active, @daily_quota_gb, @monthly_quota_gb, @wg_cascade_transport)
    `).run(client);
  },

  updateClientTransport(id: string, transport: "xray" | "hy2"): void {
    db.prepare("UPDATE clients SET wg_cascade_transport = ? WHERE id = ?").run(transport, id);
  },

  // Active-agnostic list of WG clients that route their cascade over Hy2. Used to
  // rebuild Server A's XRay source-routing rules. Suspended clients are included
  // (their WG peer is gone, so the rule is inert) so resume needs no A restart.
  getWgHy2RouteClients(): Array<{ id: string; name: string; wg_ip: string }> {
    return db.prepare(
      `SELECT id, name, wg_ip FROM clients
       WHERE type IN ('wg','both') AND wg_ip IS NOT NULL AND wg_cascade_transport = 'hy2'`
    ).all() as Array<{ id: string; name: string; wg_ip: string }>;
  },

  deleteClient(id: string): void {
    db.prepare("DELETE FROM clients WHERE id = ?").run(id);
  },

  setClientActive(id: string, active: boolean, suspendReason?: string | null): void {
    if (active) {
      db.prepare("UPDATE clients SET is_active = 1, suspend_reason = NULL WHERE id = ?").run(id);
    } else {
      db.prepare("UPDATE clients SET is_active = 0, suspend_reason = ? WHERE id = ?").run(suspendReason ?? null, id);
    }
  },

  updateClientQuota(id: string, dailyQuotaGb: number | null, monthlyQuotaGb: number | null): void {
    db.prepare("UPDATE clients SET daily_quota_gb = ?, monthly_quota_gb = ? WHERE id = ?").run(dailyQuotaGb, monthlyQuotaGb, id);
  },

  updateClientName(id: string, newName: string): void {
    db.prepare("UPDATE clients SET name = ? WHERE id = ?").run(newName, id);
  },

  updateClientExpiry(id: string, expiresAt: string | null): void {
    db.prepare("UPDATE clients SET expires_at = ? WHERE id = ?").run(expiresAt, id);
  },

  insertTrafficSnapshot(snapshot: Omit<TrafficSnapshot, "id" | "ts">): void {
    db.prepare(`
      INSERT INTO traffic_snapshots (client_id, wg_rx, wg_tx, xray_rx, xray_tx, hy2_rx, hy2_tx)
      VALUES (@client_id, @wg_rx, @wg_tx, @xray_rx, @xray_tx, @hy2_rx, @hy2_tx)
    `).run(snapshot);
  },

  getTrafficHistory(clientId: string, limit = 144): TrafficSnapshot[] {
    return db.prepare(`
      SELECT * FROM traffic_snapshots
      WHERE client_id = ?
      ORDER BY ts DESC
      LIMIT ?
    `).all(clientId, limit) as TrafficSnapshot[];
  },

  getExpiredClients(): Client[] {
    return db.prepare(`
      SELECT * FROM clients
      WHERE expires_at IS NOT NULL
        AND expires_at <= datetime('now')
        AND is_active = 1
    `).all() as Client[];
  },

  getActiveClients(): Client[] {
    return db.prepare("SELECT * FROM clients WHERE is_active = 1").all() as Client[];
  },

  getLastTrafficSnapshot(clientId: string): TrafficSnapshot | undefined {
    return db.prepare(`
      SELECT * FROM traffic_snapshots
      WHERE client_id = ?
      ORDER BY ts DESC
      LIMIT 1
    `).get(clientId) as TrafficSnapshot | undefined;
  },

  getPagedClients(page: number, pageSize = 5): { clients: Client[]; total: number } {
    const offset = page * pageSize;
    const clients = db.prepare(
      "SELECT * FROM clients ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ).all(pageSize, offset) as Client[];
    const { total } = db.prepare("SELECT COUNT(*) as total FROM clients").get() as { total: number };
    return { clients, total };
  },

  getTrafficTotalsForClients(clientIds: string[]): Map<string, TrafficTotals> {
    if (clientIds.length === 0) return new Map();
    const placeholders = clientIds.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT client_id,
             SUM(wg_rx) AS wgRx,
             SUM(wg_tx) AS wgTx,
             SUM(xray_rx) AS xrayRx,
             SUM(xray_tx) AS xrayTx,
             SUM(hy2_rx) AS hy2Rx,
             SUM(hy2_tx) AS hy2Tx
      FROM traffic_snapshots
      WHERE client_id IN (${placeholders})
        AND ts >= datetime('now', '-24 hours')
      GROUP BY client_id
    `).all(...clientIds) as Array<{ client_id: string; wgRx: number; wgTx: number; xrayRx: number; xrayTx: number; hy2Rx: number; hy2Tx: number }>;
    const map = new Map<string, TrafficTotals>();
    for (const row of rows) {
      map.set(row.client_id, { wgRx: row.wgRx, wgTx: row.wgTx, xrayRx: row.xrayRx, xrayTx: row.xrayTx, hy2Rx: row.hy2Rx, hy2Tx: row.hy2Tx });
    }
    return map;
  },

  // ── Server traffic snapshots ───────────────────────────────────────────────

  insertServerTrafficSnapshot(serverId: "a" | "b", rxBytes: number, txBytes: number): void {
    db.prepare(`
      INSERT INTO server_traffic_snapshots (server_id, rx_bytes, tx_bytes)
      VALUES (?, ?, ?)
    `).run(serverId, rxBytes, txBytes);
  },

  getServerTraffic(serverId: "a" | "b", limit: number): ServerTrafficSnapshot[] {
    const rows = db.prepare(`
      SELECT * FROM server_traffic_snapshots
      WHERE server_id = ?
      ORDER BY ts DESC
      LIMIT ?
    `).all(serverId, limit) as ServerTrafficSnapshot[];
    return rows.reverse();
  },

  getServerTrafficSparkline(serverId: "a" | "b", limit: number): Array<{ ts: string; rx: number; tx: number }> {
    const rows = db.prepare(`
      SELECT ts, rx_bytes AS rx, tx_bytes AS tx
      FROM server_traffic_snapshots
      WHERE server_id = ?
      ORDER BY ts DESC
      LIMIT ?
    `).all(serverId, limit) as Array<{ ts: string; rx: number; tx: number }>;
    return rows.reverse();
  },

  getAggregateServerTraffic(limit: number): Array<{ ts: string; rx: number; tx: number }> {
    const rows = db.prepare(`
      SELECT ts,
             SUM(rx_bytes) AS rx,
             SUM(tx_bytes) AS tx
      FROM server_traffic_snapshots
      GROUP BY ts
      ORDER BY ts DESC
      LIMIT ?
    `).all(limit) as Array<{ ts: string; rx: number; tx: number }>;
    return rows.reverse();
  },

  getServerTrafficTotals24h(): { totalRx: number; totalTx: number } {
    const row = db.prepare(`
      SELECT COALESCE(SUM(rx_bytes), 0) AS totalRx,
             COALESCE(SUM(tx_bytes), 0) AS totalTx
      FROM server_traffic_snapshots
      WHERE ts >= datetime('now', '-1 day')
    `).get() as { totalRx: number; totalTx: number };
    return row;
  },

  getServerTrafficTotals24hById(serverId: "a" | "b"): { totalRx: number; totalTx: number } {
    const row = db.prepare(`
      SELECT COALESCE(SUM(rx_bytes), 0) AS totalRx,
             COALESCE(SUM(tx_bytes), 0) AS totalTx
      FROM server_traffic_snapshots
      WHERE server_id = ?
        AND ts >= datetime('now', '-1 day')
    `).get(serverId) as { totalRx: number; totalTx: number };
    return row;
  },

  // ── Monthly rollup ─────────────────────────────────────────────────────────

  rollupClientTraffic(): number {
    const rollup = db.transaction(() => {
      const rows = db.prepare(`
        SELECT client_id,
               strftime('%Y-%m', ts) AS month,
               SUM(wg_rx + xray_rx + hy2_rx)  AS rx_total,
               SUM(wg_tx + xray_tx + hy2_tx)  AS tx_total
        FROM traffic_snapshots
        WHERE ts < datetime('now', '-30 days')
        GROUP BY client_id, month
      `).all() as Array<{ client_id: string; month: string; rx_total: number; tx_total: number }>;

      for (const row of rows) {
        db.prepare(`
          INSERT INTO client_traffic_monthly (client_id, month, rx_total, tx_total)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(client_id, month) DO UPDATE SET
            rx_total = rx_total + excluded.rx_total,
            tx_total = tx_total + excluded.tx_total
        `).run(row.client_id, row.month, row.rx_total, row.tx_total);
      }

      const { count } = db.prepare(`
        SELECT COUNT(*) AS count FROM traffic_snapshots
        WHERE ts < datetime('now', '-30 days')
      `).get() as { count: number };

      db.prepare(`DELETE FROM traffic_snapshots WHERE ts < datetime('now', '-30 days')`).run();
      return count;
    });
    return rollup() as number;
  },

  rollupServerTraffic(): number {
    const rollup = db.transaction(() => {
      const rows = db.prepare(`
        SELECT server_id,
               strftime('%Y-%m', ts) AS month,
               SUM(rx_bytes) AS rx_total,
               SUM(tx_bytes) AS tx_total
        FROM server_traffic_snapshots
        WHERE ts < datetime('now', '-30 days')
        GROUP BY server_id, month
      `).all() as Array<{ server_id: string; month: string; rx_total: number; tx_total: number }>;

      for (const row of rows) {
        db.prepare(`
          INSERT INTO server_traffic_monthly (server_id, month, rx_total, tx_total)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(server_id, month) DO UPDATE SET
            rx_total = rx_total + excluded.rx_total,
            tx_total = tx_total + excluded.tx_total
        `).run(row.server_id, row.month, row.rx_total, row.tx_total);
      }

      const { count } = db.prepare(`
        SELECT COUNT(*) AS count FROM server_traffic_snapshots
        WHERE ts < datetime('now', '-30 days')
      `).get() as { count: number };

      db.prepare(`DELETE FROM server_traffic_snapshots WHERE ts < datetime('now', '-30 days')`).run();
      return count;
    });
    return rollup() as number;
  },

  updateLastSeen(clientId: string): void {
    db.prepare("UPDATE clients SET last_seen_at = datetime('now') WHERE id = ?").run(clientId);
  },

  getServerDailyTraffic(serverId: "a" | "b"): DailyTraffic[] {
    const mod = tzModifier();
    return db.prepare(`
      SELECT date(ts, '${mod}') AS day,
             SUM(rx_bytes) AS rx_total,
             SUM(tx_bytes) AS tx_total
      FROM server_traffic_snapshots
      WHERE server_id = ? AND ts >= datetime('now', '-30 days')
      GROUP BY date(ts, '${mod}')
      ORDER BY day
    `).all(serverId) as DailyTraffic[];
  },

  getClientDailyTraffic(clientId: string): DailyTraffic[] {
    const mod = tzModifier();
    return db.prepare(`
      SELECT date(ts, '${mod}') AS day,
             SUM(wg_rx + xray_rx + hy2_rx) AS rx_total,
             SUM(wg_tx + xray_tx + hy2_tx) AS tx_total
      FROM traffic_snapshots
      WHERE client_id = ? AND ts >= datetime('now', '-30 days')
      GROUP BY date(ts, '${mod}')
      ORDER BY day
    `).all(clientId) as DailyTraffic[];
  },

  getClientMonthlyTraffic(clientId: string): MonthlyTraffic[] {
    return db.prepare(`
      SELECT month, rx_total, tx_total
      FROM client_traffic_monthly
      WHERE client_id = ?
      ORDER BY month DESC
    `).all(clientId) as MonthlyTraffic[];
  },

  getServerMonthlyTraffic(serverId: "a" | "b"): MonthlyTraffic[] {
    return db.prepare(`
      SELECT month, rx_total, tx_total
      FROM server_traffic_monthly
      WHERE server_id = ?
      ORDER BY month DESC
    `).all(serverId) as MonthlyTraffic[];
  },

  // ── Quota queries ──────────────────────────────────────────────────────────

  getClientsWithQuotas(): Client[] {
    return db.prepare(`
      SELECT * FROM clients
      WHERE is_active = 1
        AND (daily_quota_gb IS NOT NULL OR monthly_quota_gb IS NOT NULL)
    `).all() as Client[];
  },

  getQuotaSuspendedClients(reason: string): Client[] {
    return db.prepare(`
      SELECT * FROM clients WHERE is_active = 0 AND suspend_reason = ?
    `).all(reason) as Client[];
  },

  getClientDailyUsageBytes(clientId: string): number {
    const mod = tzModifier();
    const row = db.prepare(`
      SELECT COALESCE(SUM(wg_rx + wg_tx + xray_rx + xray_tx + hy2_rx + hy2_tx), 0) AS used_bytes
      FROM traffic_snapshots
      WHERE client_id = ?
        AND date(ts, '${mod}') = date('now', '${mod}')
    `).get(clientId) as { used_bytes: number };
    return row.used_bytes;
  },

  getClientMonthlyUsageBytes(clientId: string): number {
    const mod = tzModifier();
    const row = db.prepare(`
      SELECT COALESCE(SUM(wg_rx + wg_tx + xray_rx + xray_tx + hy2_rx + hy2_tx), 0) AS used_bytes
      FROM traffic_snapshots
      WHERE client_id = ?
        AND strftime('%Y-%m', ts, '${mod}') = strftime('%Y-%m', 'now', '${mod}')
    `).get(clientId) as { used_bytes: number };
    return row.used_bytes;
  },

  getQuotaUsageBatch(clientIds: string[]): Map<string, { daily_used_bytes: number; monthly_used_bytes: number }> {
    if (clientIds.length === 0) return new Map();
    const mod = tzModifier();
    const placeholders = clientIds.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT client_id,
             COALESCE(SUM(CASE WHEN date(ts, '${mod}') = date('now', '${mod}')
               THEN wg_rx + wg_tx + xray_rx + xray_tx + hy2_rx + hy2_tx ELSE 0 END), 0) AS daily_used_bytes,
             COALESCE(SUM(CASE WHEN strftime('%Y-%m', ts, '${mod}') = strftime('%Y-%m', 'now', '${mod}')
               THEN wg_rx + wg_tx + xray_rx + xray_tx + hy2_rx + hy2_tx ELSE 0 END), 0) AS monthly_used_bytes
      FROM traffic_snapshots
      WHERE client_id IN (${placeholders})
        AND strftime('%Y-%m', ts, '${mod}') = strftime('%Y-%m', 'now', '${mod}')
      GROUP BY client_id
    `).all(...clientIds) as Array<{ client_id: string; daily_used_bytes: number; monthly_used_bytes: number }>;
    const map = new Map<string, { daily_used_bytes: number; monthly_used_bytes: number }>();
    for (const row of rows) {
      map.set(row.client_id, { daily_used_bytes: row.daily_used_bytes, monthly_used_bytes: row.monthly_used_bytes });
    }
    return map;
  },

  // ── Alert queries ──────────────────────────────────────────────────────────

  getAllAlertSettings(): AlertSetting[] {
    return db.prepare("SELECT * FROM alert_settings ORDER BY alert_key").all() as AlertSetting[];
  },

  getAlertSetting(key: string): AlertSetting | undefined {
    return db.prepare("SELECT * FROM alert_settings WHERE alert_key = ?").get(key) as AlertSetting | undefined;
  },

  updateAlertSetting(key: string, updates: Partial<Pick<AlertSetting, "enabled" | "threshold" | "threshold2" | "cooldown_min">>): void {
    const entries = Object.entries(updates).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const setClauses = entries.map(([k]) => `${k} = ?`).join(", ");
    const values = entries.map(([, v]) => v);
    db.prepare(`UPDATE alert_settings SET ${setClauses} WHERE alert_key = ?`).run(...values, key);
  },

  getAlertState(key: string): AlertState | undefined {
    return db.prepare("SELECT * FROM alert_state WHERE alert_key = ?").get(key) as AlertState | undefined;
  },

  upsertAlertState(key: string, status: "fired" | "clear", context?: string): void {
    if (status === "fired") {
      db.prepare(`
        INSERT INTO alert_state (alert_key, status, fired_at, context)
        VALUES (?, 'fired', datetime('now'), ?)
        ON CONFLICT(alert_key) DO UPDATE SET
          status = 'fired', fired_at = excluded.fired_at, context = excluded.context
      `).run(key, context ?? null);
    } else {
      db.prepare(`
        INSERT INTO alert_state (alert_key, status, cleared_at)
        VALUES (?, 'clear', datetime('now'))
        ON CONFLICT(alert_key) DO UPDATE SET
          status = 'clear', cleared_at = excluded.cleared_at
      `).run(key);
    }
  },

  updateClientIp(id: string, ip: string, isp: string | null, route: "direct" | "relay" | null = null): void {
    db.prepare("UPDATE clients SET last_ip = ?, last_ip_isp = ?, last_connection_route = ? WHERE id = ?").run(ip, isp, route, id);
  },

  getClientTrafficLastHour(clientId: string): number {
    const row = db.prepare(`
      SELECT COALESCE(SUM(wg_rx + wg_tx + xray_rx + xray_tx + hy2_rx + hy2_tx), 0) AS used_bytes
      FROM traffic_snapshots
      WHERE client_id = ?
        AND ts >= datetime('now', '-1 hour')
    `).get(clientId) as { used_bytes: number };
    return row.used_bytes;
  },

  searchClients(
    search: string,
    filter: "all" | "active" | "suspended" | "quota_exceeded",
    type: "all" | "wg" | "xray" | "both" | "hysteria2",
    page: number,
    pageSize = 20
  ): { clients: Client[]; total: number } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (search) {
      conditions.push("name LIKE ?");
      params.push(`%${search}%`);
    }
    if (filter === "active") {
      conditions.push("is_active = 1");
    } else if (filter === "suspended") {
      conditions.push("is_active = 0");
    } else if (filter === "quota_exceeded") {
      conditions.push("is_active = 0 AND suspend_reason IN ('daily_quota', 'monthly_quota')");
    }
    if (type !== "all") {
      conditions.push("type = ?");
      params.push(type);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const offset = page * pageSize;

    const clients = db.prepare(
      `SELECT * FROM clients ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset) as Client[];
    const { total } = db.prepare(
      `SELECT COUNT(*) as total FROM clients ${where}`
    ).get(...params) as { total: number };

    return { clients, total };
  },

  // ── Maintenance jobs ───────────────────────────────────────────────────────

  /** Throws SqliteError(SQLITE_CONSTRAINT_UNIQUE) if the server already has an active job. */
  insertMaintenanceJob(job: Pick<MaintenanceJob, "id" | "server_id" | "action" | "status" | "requested_by">): void {
    db.prepare(`
      INSERT INTO maintenance_jobs (id, server_id, action, status, requested_by)
      VALUES (@id, @server_id, @action, @status, @requested_by)
    `).run(job);
  },

  updateMaintenanceJob(
    id: string,
    updates: Partial<Pick<MaintenanceJob,
      "status" | "phase" | "boot_id" | "started_at" | "finished_at" | "reboot_at" |
      "exit_code" | "error" | "packages_upgraded" | "packages" | "log_tail">>
  ): void {
    const entries = Object.entries(updates).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const setClauses = entries.map(([k]) => `${k} = ?`).join(", ");
    const values = entries.map(([, v]) => v);
    db.prepare(`UPDATE maintenance_jobs SET ${setClauses} WHERE id = ?`).run(...values, id);
  },

  getMaintenanceJob(id: string): MaintenanceJob | undefined {
    return db.prepare("SELECT * FROM maintenance_jobs WHERE id = ?").get(id) as MaintenanceJob | undefined;
  },

  getActiveMaintenanceJob(serverId: ServerId): MaintenanceJob | undefined {
    return db.prepare(`
      SELECT * FROM maintenance_jobs
      WHERE server_id = ? AND status IN ('queued', 'running', 'rebooting')
    `).get(serverId) as MaintenanceJob | undefined;
  },

  getLastMaintenanceJob(serverId: ServerId): MaintenanceJob | undefined {
    return db.prepare(`
      SELECT * FROM maintenance_jobs
      WHERE server_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(serverId) as MaintenanceJob | undefined;
  },

  /** Every job still considered in-flight — across all servers. Drives the worker tick. */
  getActiveMaintenanceJobs(): MaintenanceJob[] {
    return db.prepare(`
      SELECT * FROM maintenance_jobs
      WHERE status IN ('queued', 'running', 'rebooting') ORDER BY created_at
    `).all() as MaintenanceJob[];
  },

  /** Most recent terminal job per server — used for the post-reboot alert grace window. */
  getLastTerminalMaintenanceJob(serverId: ServerId): MaintenanceJob | undefined {
    return db.prepare(`
      SELECT * FROM maintenance_jobs
      WHERE server_id = ? AND status IN ('succeeded', 'failed', 'unknown')
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(serverId) as MaintenanceJob | undefined;
  },

  // ─── Backup runs ───────────────────────────────────────────────────────────

  insertBackupRun(row: { id: string; trigger: BackupTrigger }): void {
    db.prepare(`
      INSERT INTO backup_runs (id, trigger, status) VALUES (@id, @trigger, 'running')
    `).run(row);
  },

  /** Same dynamic-SET idiom as updateMaintenanceJob; always stamps finished_at. */
  finishBackupRun(
    id: string,
    updates: Partial<Pick<BackupRun,
      "status" | "bundle_bytes" | "db_bytes" | "telegram_ok" |
      "local_path" | "wg_key_included" | "error">>
  ): void {
    const entries = Object.entries(updates).filter(([, v]) => v !== undefined);
    const setClauses = [...entries.map(([k]) => `${k} = ?`), "finished_at = datetime('now')"].join(", ");
    const values = entries.map(([, v]) => v);
    db.prepare(`UPDATE backup_runs SET ${setClauses} WHERE id = ?`).run(...values, id);
  },

  /**
   * Newest run, optionally restricted to a set of statuses. Staleness and the
   * startup catch-up both pass ['success','degraded'] — a local-only bundle still
   * counts as "a backup exists"; persistent delivery failure is surfaced by the
   * repeating backup_failed alerts instead.
   */
  getLastBackupRun(statuses?: BackupStatus[]): BackupRun | undefined {
    if (!statuses || statuses.length === 0) {
      return db.prepare(
        "SELECT * FROM backup_runs ORDER BY started_at DESC, rowid DESC LIMIT 1"
      ).get() as BackupRun | undefined;
    }
    const placeholders = statuses.map(() => "?").join(", ");
    return db.prepare(`
      SELECT * FROM backup_runs WHERE status IN (${placeholders})
      ORDER BY started_at DESC, rowid DESC LIMIT 1
    `).get(...statuses) as BackupRun | undefined;
  },

  getBackupRuns(limit: number): BackupRun[] {
    return db.prepare(
      "SELECT * FROM backup_runs ORDER BY started_at DESC, rowid DESC LIMIT ?"
    ).all(limit) as BackupRun[];
  },

  /**
   * Reap rows left 'running' by a crash or a restart mid-backup. Scoped to rows
   * older than the current process start so it can never reap a live run — the
   * worker calls this synchronously at construction, but the scope makes the
   * guarantee independent of that ordering.
   */
  failStuckBackupRuns(processStartIso: string): number {
    const result = db.prepare(`
      UPDATE backup_runs
      SET status = 'failed', error = 'interrupted by restart', finished_at = datetime('now')
      WHERE status = 'running' AND started_at < ?
    `).run(processStartIso);
    return result.changes;
  },
};
