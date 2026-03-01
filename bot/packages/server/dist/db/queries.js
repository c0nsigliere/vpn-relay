"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.queries = void 0;
const index_1 = require("./index");
exports.queries = {
    getAllClients() {
        return index_1.db.prepare("SELECT * FROM clients ORDER BY created_at DESC").all();
    },
    getClientById(id) {
        return index_1.db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
    },
    getClientByName(name) {
        return index_1.db.prepare("SELECT * FROM clients WHERE name = ?").get(name);
    },
    insertClient(client) {
        index_1.db.prepare(`
      INSERT INTO clients (id, name, type, wg_ip, wg_pubkey, xray_uuid, expires_at, is_active)
      VALUES (@id, @name, @type, @wg_ip, @wg_pubkey, @xray_uuid, @expires_at, @is_active)
    `).run(client);
    },
    deleteClient(id) {
        index_1.db.prepare("DELETE FROM clients WHERE id = ?").run(id);
    },
    setClientActive(id, active) {
        index_1.db.prepare("UPDATE clients SET is_active = ? WHERE id = ?").run(active ? 1 : 0, id);
    },
    insertTrafficSnapshot(snapshot) {
        index_1.db.prepare(`
      INSERT INTO traffic_snapshots (client_id, wg_rx, wg_tx, xray_rx, xray_tx)
      VALUES (@client_id, @wg_rx, @wg_tx, @xray_rx, @xray_tx)
    `).run(snapshot);
    },
    getTrafficHistory(clientId, limit = 144) {
        return index_1.db.prepare(`
      SELECT * FROM traffic_snapshots
      WHERE client_id = ?
      ORDER BY ts DESC
      LIMIT ?
    `).all(clientId, limit);
    },
    getExpiredClients() {
        return index_1.db.prepare(`
      SELECT * FROM clients
      WHERE expires_at IS NOT NULL
        AND expires_at <= datetime('now')
        AND is_active = 1
    `).all();
    },
    getActiveClients() {
        return index_1.db.prepare("SELECT * FROM clients WHERE is_active = 1").all();
    },
    getLastTrafficSnapshot(clientId) {
        return index_1.db.prepare(`
      SELECT * FROM traffic_snapshots
      WHERE client_id = ?
      ORDER BY ts DESC
      LIMIT 1
    `).get(clientId);
    },
    getPagedClients(page, pageSize = 5) {
        const offset = page * pageSize;
        const clients = index_1.db.prepare("SELECT * FROM clients ORDER BY created_at DESC LIMIT ? OFFSET ?").all(pageSize, offset);
        const { total } = index_1.db.prepare("SELECT COUNT(*) as total FROM clients").get();
        return { clients, total };
    },
    searchClients(search, filter, type, page, pageSize = 20) {
        const conditions = [];
        const params = [];
        if (search) {
            conditions.push("name LIKE ?");
            params.push(`%${search}%`);
        }
        if (filter === "active") {
            conditions.push("is_active = 1");
        }
        else if (filter === "suspended") {
            conditions.push("is_active = 0");
        }
        if (type !== "all") {
            conditions.push("type = ?");
            params.push(type);
        }
        const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
        const offset = page * pageSize;
        const clients = index_1.db.prepare(`SELECT * FROM clients ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
        const { total } = index_1.db.prepare(`SELECT COUNT(*) as total FROM clients ${where}`).get(...params);
        return { clients, total };
    },
};
//# sourceMappingURL=queries.js.map