Telegram Bot Control Plane: Technical Specification for AI Agent
1. System Overview & Context
This document defines the technical specification for a Telegram bot acting as the Control Plane for a highly resilient, two-node VPN infrastructure designed to bypass DPI (e.g., Russian TSPU). The bot eliminates the need to run Ansible playbooks manually for day-to-day client lifecycle management.

Infrastructure Context (Ansible-Managed):

Server A (Entry/Relay Node): Terminates WireGuard clients on wg-clients (UDP 51888). Uses XRay TPROXY (port 12345) to intercept and forward decrypted WG traffic to Server B. Also acts as a pure TCP L4 relay (TCP 443 → Server B 8443) for XRay clients. Holds no XRay secrets.

Server B (Exit/Core Node): Hosts the Telegram Bot, SQLite database, and the native XRay (VLESS+Reality) server (TCP 8443). Holds the Reality private keys. Does not run WireGuard.

Separation of Concerns: Ansible provisions the immutable infrastructure (packages, iptables, routing, systemd, TPROXY rules). The Telegram Bot manages the dynamic state of the users (adding/removing, monitoring traffic, generating configs).

2. Architecture & Repository Integration
The bot's source code resides in a dedicated bot/ directory at the root of the existing Ansible repository. A new Ansible role (telegram_bot) will deploy it natively to Server B.

Plaintext
vpn-relay/
├── bot/                           <-- BOT SOURCE CODE (AI Agent Scope)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/                       # TypeScript source files
├── playbooks/
│   ├── stack.yml                  # Updated to call deploy_bot.yml at the end
│   └── deploy_bot.yml             # New playbook to deploy the bot to Server B
└── roles/
    ├── telegram_bot/              # Ansible role: Node.js, syncs bot code, systemd
    ├── wg_cascade/                
    ├── relay/                     
    └── xray_server/               
3. Technical Stack
Language: TypeScript (Node.js v20+)

Bot Framework: grammY (Core, Session, and Inline/Menu plugins)

Database: better-sqlite3 (Strictly synchronous; ensures robust local file DB operations)

SSH Client: ssh2 (For executing WireGuard wg commands remotely on Server A)

XRay Integration: @grpc/grpc-js and @grpc/proto-loader (For real-time user management via gRPC API) + fs (to sync state with /etc/xray/clients.json)

Charts: chartjs-node-canvas and chart.js (For generating traffic graphs locally as Buffer/PNG)

Task Scheduling: node-cron or native setInterval

4. Database Schema (SQLite)
The database file data.db must be mounted outside the app directory (e.g., /var/lib/vpn-bot/data.db) to survive Ansible deployments.

SQL
CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,            -- UUID
    name TEXT NOT NULL UNIQUE,      -- e.g., "Alice_Phone"
    type TEXT NOT NULL,             -- 'wg', 'xray', or 'both'
    wg_ip TEXT,                     -- e.g., "10.66.0.5"
    wg_pubkey TEXT,                 -- WireGuard Public Key
    xray_uuid TEXT,                 -- XRay VLESS UUID
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,            -- Optional TTL for temporary access
    is_active BOOLEAN DEFAULT 1
);

CREATE TABLE IF NOT EXISTS traffic_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    ts DATETIME DEFAULT CURRENT_TIMESTAMP,
    wg_rx INTEGER DEFAULT 0,        -- Bytes received (from Server A)
    wg_tx INTEGER DEFAULT 0,        -- Bytes transmitted (from Server A)
    xray_rx INTEGER DEFAULT 0,      -- Bytes received (from Server B gRPC)
    xray_tx INTEGER DEFAULT 0,      -- Bytes transmitted (from Server B gRPC)
    FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE
);
5. Telegram UI/UX (Strict Rules)
Navigation: NO slash commands for navigation. The only allowed command is /start. Everything must be handled via Inline Keyboards and message editing (ctx.editMessageText) to prevent chat clutter.

State Management: Use grammY sessions to track when the bot is waiting for user text input (e.g., expecting a new client's name).

Menu Structure:

Main Menu:

[ ➕ Add Client ] -> Prompts for Type (WG/XRay/Both) -> Prompts for Name.

[ 👥 Client List ] -> Shows a paginated list of clients.

[ 📊 Server Status ] -> Shows CPU, RAM, Uptime, and OS Update Status for Server A and Server B.

[ ⚙️ Settings ] -> Options like [ 💾 Download DB Backup ].

Client Card (upon selecting a client):

Displays: Name, Type, Status, Expiry, Total Traffic this month.

[ 🔑 Get Config ] ->

For WG: Sends the parsed .conf file.

For XRay: Sends two VLESS URIs (Direct & Relay), QR codes, and a recommendation to use the Hiddify or Streisand apps for connection.

[ 📈 Traffic Graph ] -> Generates and sends a PNG chart inline.

[ ⏸ Suspend ] / [ ▶️ Resume ] -> Toggles is_active state.

[ 🗑 Delete Client ] -> Prompts for confirmation -> Deletes from DB, WG (Server A), and XRay (Server B).

6. Core Workflows & Integrations
6.1 WireGuard Management (Remote via SSH to Server A)
Connection details (IP, User, Key path) are provided via .env.

Add Client:

Generate keys locally (on Server B): wg genkey | tee privatekey | wg pubkey > publickey.

Determine the next available IP in 10.66.0.0/24.

SSH to Server A: wg set wg-clients peer <pubkey> allowed-ips <ip>/32.

SSH to Server A: Append peer to /etc/wireguard/wg-clients.conf OR run wg-quick save wg-clients (ensure persistence aligns with Ansible state).

Generate the client .conf file in memory (Endpoint: Server_A_IP:51888, DNS: 1.1.1.1, 1.0.0.1) and send to Telegram.

Remove/Suspend Client:

SSH to Server A: wg set wg-clients peer <pubkey> remove.

Remove from persistent config on Server A.

Statistics:

SSH to Server A: wg show wg-clients dump.

Parse output to extract RX/TX bytes per public key.

6.2 XRay Management (Local via gRPC & File on Server B)
Add Client:

Generate a new UUID (crypto.randomUUID()).

Call XRay gRPC API HandlerService.AlterInbound (AddUser operation) to add the user to memory instantly without restarting the service.

Update the local /etc/xray/clients.json file so the user persists after an OS reboot or XRay service restart.

Generate two VLESS URIs strictly adhering to DPI evasion parameters:

Direct URI (#name): Connects directly to Server B (8443). Flow: xtls-rprx-vision, SNI: www.googletagmanager.com, FP: chrome.

Relay URI (#name-via-relay): Connects to Server A (443). Flow: xtls-rprx-vision, SNI: www.googletagmanager.com, FP: chrome.

Remove/Suspend Client:

Call XRay gRPC API HandlerService.AlterInbound (RemoveUser operation).

Remove the user's UUID from /etc/xray/clients.json.

Statistics:

Call XRay gRPC API StatsService.QueryStats matching the client's email/UUID to get current byte counters.

7. Background Workers
Traffic Sync (10m): Fetch stats from WG (SSH to A) and XRay (gRPC on B), calculate the delta since the last snapshot, and insert a new row into traffic_snapshots.

TTL Expiry (1h): Check if any client's expires_at has passed. If so, automatically suspend them (remove from WG/XRay memory, set is_active = 0) and notify the admin.

Healthcheck Alert (1m): Ping and test SSH reachability to Server A. If it fails 3 consecutive times, send an alert to ADMIN_ID.

OS Update Monitor (12h):

Local check (Server B) and Remote check (Server A via SSH).

Run /usr/lib/update-notifier/apt-check 2>&1.

Check if /var/run/reboot-required exists.

If security updates > 0 OR a reboot is required, proactively message ADMIN_ID (e.g., "⚠️ Server A: 5 security updates pending. Reboot required.").

8. Security & Authorization
Admin Only: Implement a grammY middleware that strictly verifies ctx.from.id matches the ADMIN_ID from the .env file. Silently ignore all messages, commands, or callbacks from unauthorized user IDs.

Zero-Secret Forwarding: Ensure the bot never attempts to send or copy Reality private keys from Server B to Server A.

Graceful Shutdown: Intercept SIGINT and SIGTERM to safely close the SQLite connection, terminate the SSH pool to Server A, and close gRPC channels before the Node.js process exits.

9. Expected Source Code Structure (bot/src/)
Plaintext
src/
├── index.ts               # Entry point, bot initialization, graceful shutdown
├── config/
│   └── env.ts             # Zod validation for .env variables (IPs, ADMIN_ID, etc.)
├── db/
│   ├── index.ts           # better-sqlite3 instance
│   └── queries.ts         # SQL wrapper functions
├── bot/
│   ├── middlewares/       # Auth middleware, session initialization
│   ├── menus/             # grammY inline menu definitions
│   └── handlers/          # Text input handlers (e.g., waiting for client name)
├── services/
│   ├── wg.service.ts      # ssh2 wrapper for WireGuard commands on Server A
│   ├── xray.service.ts    # gRPC client for XRay + clients.json file sync
│   ├── charts.service.ts  # chartjs-node-canvas generator
│   └── system.service.ts  # OS metrics (CPU, RAM) and OS Updates/Reboot checks
└── workers/
    ├── traffic.worker.ts  # 10-minute cron job
    ├── health.worker.ts   # 1-minute server A reachability check
    └── updates.worker.ts  # 12-hour cron job for APT/Reboot notifications