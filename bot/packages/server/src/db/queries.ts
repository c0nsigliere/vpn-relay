import { db } from "./index";
import type { Client, TrafficSnapshot, TrafficTotals } from "@vpn-relay/shared";

export type { Client, TrafficSnapshot, TrafficTotals };

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

  insertClient(client: Omit<Client, "created_at">): void {
    db.prepare(`
      INSERT INTO clients (id, name, type, wg_ip, wg_pubkey, xray_uuid, expires_at, is_active)
      VALUES (@id, @name, @type, @wg_ip, @wg_pubkey, @xray_uuid, @expires_at, @is_active)
    `).run(client);
  },

  deleteClient(id: string): void {
    db.prepare("DELETE FROM clients WHERE id = ?").run(id);
  },

  setClientActive(id: string, active: boolean): void {
    db.prepare("UPDATE clients SET is_active = ? WHERE id = ?").run(active ? 1 : 0, id);
  },

  insertTrafficSnapshot(snapshot: Omit<TrafficSnapshot, "id" | "ts">): void {
    db.prepare(`
      INSERT INTO traffic_snapshots (client_id, wg_rx, wg_tx, xray_rx, xray_tx)
      VALUES (@client_id, @wg_rx, @wg_tx, @xray_rx, @xray_tx)
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
             SUM(xray_tx) AS xrayTx
      FROM traffic_snapshots
      WHERE client_id IN (${placeholders})
      GROUP BY client_id
    `).all(...clientIds) as Array<{ client_id: string; wgRx: number; wgTx: number; xrayRx: number; xrayTx: number }>;
    const map = new Map<string, TrafficTotals>();
    for (const row of rows) {
      map.set(row.client_id, { wgRx: row.wgRx, wgTx: row.wgTx, xrayRx: row.xrayRx, xrayTx: row.xrayTx });
    }
    return map;
  },

  searchClients(
    search: string,
    filter: "all" | "active" | "suspended",
    type: "all" | "wg" | "xray" | "both",
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
};
