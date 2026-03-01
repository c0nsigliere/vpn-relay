"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const env_1 = require("../config/env");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// Ensure data directory exists
const dbDir = path.dirname(env_1.env.DB_PATH);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}
exports.db = new better_sqlite3_1.default(env_1.env.DB_PATH);
// Performance settings
exports.db.pragma("journal_mode = WAL");
exports.db.pragma("foreign_keys = ON");
exports.db.pragma("synchronous = NORMAL");
// Schema
exports.db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('wg', 'xray', 'both')),
    wg_ip TEXT,
    wg_pubkey TEXT,
    xray_uuid TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    is_active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS traffic_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    ts DATETIME DEFAULT CURRENT_TIMESTAMP,
    wg_rx INTEGER DEFAULT 0,
    wg_tx INTEGER DEFAULT 0,
    xray_rx INTEGER DEFAULT 0,
    xray_tx INTEGER DEFAULT 0,
    FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
`);
//# sourceMappingURL=index.js.map