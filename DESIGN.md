# 🧱 Проект: VPN Stack (WireGuard Cascade + XRay Reality via Relay)

## 🎯 Цель проекта

Развернуть управляемый через Ansible VPN-стек из двух серверов:

* **Server A (в РФ)** — входная точка
* **Server B (вне РФ)** — реальный выход в интернет

Система должна:

1. Работать при блокировках (к B напрямую подключиться нельзя).
2. Поддерживать:

   * WireGuard VPN (через каскад A→B)
   * XRay VLESS + Reality (через TCP relay на A к B)
3. Быть полностью управляемой через Ansible.
4. Быть легко переносимой (замена A или B не должна ломать архитектуру).
5. Позволять автоматическую генерацию клиентских конфигов.
6. Иметь проверку памяти/Swap.
7. Иметь один “Golden Path” для установки.

---

# 🖥 Архитектура

## 1️⃣ WireGuard Cascade (VPN plane)

```
Client → Server A :51888/udp (wg-clients 10.66.0.0/24)
        → iptables TPROXY → XRay :12345 (TPROXY inbound, knows original dst)
        → XRay VLESS+Reality (TCP, DPI bypass) → Server B XRay :8443
        → freedom outbound → Internet (original dst preserved)
```

**Почему XRay TPROXY:** Российские ISP (ТСПУ) блокируют весь исходящий
UDP из РФ за рубеж. WireGuard wg-uplink не может соединиться с Server B
напрямую. Вместо этого XRay TPROXY перехватывает весь расшифрованный
WireGuard-трафик и передаёт его через VLESS+Reality на Server B.
Server B больше не имеет WireGuard — только XRay.

### Server A:

* Интерфейс: `wg-clients` — 10.66.0.0/24, порт 51888/udp
* iptables mangle PREROUTING: `-i wg-clients -j TPROXY --on-port 12345 --tproxy-mark 0x1`
* ip rule: `fwmark 0x1 → table 100`, ip route: `local 0.0.0.0/0 dev lo table 100`
* XRay client (роль `relay`):
  * TPROXY inbound (dokodemo-door + followRedirect) на порту 12345
  * VLESS+Reality outbound → Server B:8443
  * Reality pubkey читается с Server B во время деплоя
  * UUID: `xray_wg_uplink_uuid` (group_vars/all.yml)
* SSH и основной default route НЕ ломаются (TPROXY применяется только к wg-clients)

### Server B:

* WireGuard полностью удалён
* XRay принимает VLESS+Reality, `freedom` outbound создаёт соединения с оригинальным dst
* NAT через XRay на уровне приложения — iptables MASQUERADE на B не нужен

---

## 2️⃣ XRay Access (Proxy plane)

```
Client → Server A :443/tcp (TCP relay DNAT)
        → Server B :8443/tcp (XRay VLESS+Reality)
        → Internet
```

### Server A:

* TCP relay: DNAT 443/tcp → B:8443/tcp
* Роль `relay` — только DNAT + MASQUERADE + XRay uplink client
* Reality private key никогда не попадает на A

### Server B:

* XRay (systemd), VLESS + Reality, порт 8443/tcp
* Порт 443: принимается через TCP relay на Server A
* Reality private key хранится только на B (`/etc/xray/keys/`)
* Клиенты в `/etc/xray/clients.json`; wg-uplink peer — отдельный UUID без flow

---

# 🧠 Протокол XRay

* Протокол: VLESS
* Transport: TCP
* Security: Reality
* encryption: none
* SNI: `www.googletagmanager.com`
* Fingerprint: `chrome`
* Flow: `xtls-rprx-vision` (TLS-in-TLS splice, DPI protection)
* Clients хранятся в `/etc/xray/clients.json`
* Reality ключи:

  * `/etc/xray/keys/reality.key`
  * `/etc/xray/keys/reality.pub`
  * `/etc/xray/keys/shortid`

---

# 🧩 Репозиторий Ansible

## Роли

### roles/wg_cascade

* Только Server A (Server B больше не в группе `wg_cascade`)
* Генерация ключей (только wg-clients)
* TPROXY iptables mangle rules
* Routing (TPROXY fwmark через wg-clients PostUp/PreDown)
* Firewall
* Services (только wg-clients)
* Verify
* Memory parser (/proc/meminfo)

### roles/xray_server

* Только Server B
* Установка XRay binary
* Генерация Reality ключей
* clients.json
* systemd service
* Firewall allow 443
* Verify

### roles/relay

* Только Server A
* DNAT TCP (443 → B:8443)
* MASQUERADE + FORWARD rules
* UFW keep mode
* **XRay TPROXY client** — устанавливает XRay binary, пишет config из шаблона
  `xray-uplink-client.json.j2` (TPROXY inbound + VLESS+Reality outbound)
  Читает Reality pubkey с Server B через delegate_to
* Verify

### roles/maintenance

* update / upgrade
* reboot-if-needed
* health
* swap logic

---

# 📂 Playbooks (финальная модель)

## Основные

### playbooks/stack.yml

Единственный entrypoint для установки с нуля.

Порядок:

1. maintenance (update/upgrade)
2. swap (если нет)
3. wg_cascade (A+B)
4. xray_server (B)
5. relay (A)
6. verify_all
7. bot (optional, if `bot_telegram_token` set)
8. tma (optional, if `tma_domain` set)

---

### playbooks/verify_all.yml

Проверяет:

* wg handshakes
* ip rule table 200
* wg-uplink default route
* relay DNAT rules
* xray service active
* port 443 listening on B
* MemAvailable
* SwapTotal
* free -h
* External TCP reachability: controller → A:`port_a_tcp`, controller → B:`port_b_tcp`

Если:

* MemAvailable < 128MB → WARN
* SwapTotal == 0 → WARN
* TCP endpoint unreachable → WARN (assert с `ignore_errors: true`)

Не падает, только предупреждает.

---

### playbooks/add_wg_client.yml

Добавляет WireGuard клиента:

* генерит ключи
* пушит pubkey на A
* генерит `artifacts/clients/<name>.conf`

---

### playbooks/backup.yml

Бэкап критического состояния серверов в `artifacts/backup/<timestamp>/`:
* WG ключи и конфиг с Server A
* Reality ключи, clients.json и БД бота с Server B
* Symlink `latest` → текущий бэкап

### playbooks/restore.yml

Восстановление из бэкапа:
* По умолчанию `latest`, override через `-e "backup_name=..."`
* Re-template config.json после восстановления ключей
* После restore запустить `stack.yml` для полной рекенфигурации

---

### playbooks/add_xray_client.yml

Добавляет XRay клиента:

* генерит UUID
* обновляет `/etc/xray/clients.json`
* перерендерит config.json
* перезапускает xray
* генерит артефакты на контроллере:

```
artifacts/xray/<user>.vless.txt
artifacts/xray/<user>.json
artifacts/xray/<user>.qr.png (если qrencode)
```

В конфиге клиента:

* address = Server A public IP
* port = 443
* pbk = reality public key
* sid = shortId
* sni = www.microsoft.com
* fp = chrome

---

# 🌍 Inventory

## Hosts

```
server_a
server_b
```

## Groups

```
wg_cascade: children
  server_a         # Server B removed — no WireGuard on B

xray_servers:
  server_b

relay_servers:
  server_a
```

---

# ⚙️ Переменные

## Shared (group_vars/all.yml) — single source of truth for all ports

* server_b_public_ip
* xray_port (8443)
* port_a_tcp (443)
* port_b_tcp (derives from xray_port)
* wg_clients_port (51888)
* xray_tproxy_port (12345)
* xray_tproxy_table (100)
* xray_version (26.2.6)
* manage_ufw
* wan_if
* maintenance flags

## Cascade (wg_cascade.yml — non-port overrides only)

* wg_clients_net
* wg_clients_addr_a
* wg_client_dns

## Relay (relay_servers.yml — non-port overrides only)

* (ports come from all.yml)

## XRay (xray_servers.yml — non-port overrides only)

* xray_reality_dest
* xray_reality_server_names
* xray_reality_fingerprint
* xray_vless_flow

---

# 🔐 Безопасность

* Reality private key остаётся только на B
* config.json 0600
* /etc/xray 0700
* no_log для ключей
* relay не хранит секретов
* wg cascade не ломает default route A

---

# 🧠 Принципы проекта

1. Один entrypoint: `stack.yml`
2. Роли независимы
3. Легко заменить A или B:

   * меняется inventory
   * перезапуск stack
4. Не используется Docker для XRay
5. Relay — чистый L4, без логики прокси
6. Все клиенты подключаются к A
7. B никогда не является публичной точкой входа
8. Swap обязателен для маленьких VPS
9. Maintenance выполняется на обоих серверах
10. Верификация обязательна

---

# 🚀 Golden Path

```
ansible-playbook playbooks/stack.yml
ansible-playbook playbooks/verify_all.yml
```

Добавить WG клиента:

```
ansible-playbook playbooks/add_wg_client.yml -e "client_name=..."
```

Добавить XRay клиента:

```
ansible-playbook playbooks/add_xray_client.yml -e "client_name=..."
```

---

# 📌 Текущее состояние

* WireGuard cascade работает (XRay TPROXY — wg-uplink и WireGuard на B полностью удалены)
* XRay TPROXY перехватывает wg-clients трафик на Server A, туннелирует через VLESS+Reality на B
* Relay TCP работает (A:443 → B:8443, DNAT+MASQUERADE)
* Native XRay развёрнут (systemd, без Docker)
* Amnezia/Docker полностью удалены из кодовой базы
* Реализован single-entry entrypoint `stack.yml`
* DPI hardening: порт 8443 на relay, SNI `www.googletagmanager.com`, flow `xtls-rprx-vision` — активны по умолчанию
* Control-plane (Telegram бот) — реализован (`bot/`, роль `telegram_bot`, `playbooks/deploy_bot.yml`)

---

## 3️⃣ Telegram Bot Control Plane

```
Admin (Telegram)
    │
    ▼
Bot (Server B) ─── gRPC :10085 ──► XRay (local)
    │                                  (HandlerService + StatsService)
    │                                  /etc/xray/clients.json (atomic write)
    │
    └─── SSH ed25519 ──────────────► Server A
                                       wg set / wg syncconf / wg show dump
```

**Stack:** TypeScript + Node.js 20 + pnpm workspace, grammy, better-sqlite3, ssh2, Fastify

**Bot source:** `bot/packages/server/src/` — deployed to `/opt/vpn-bot` on Server B via Ansible role `telegram_bot`

**Services:**
- `xray.service.ts` — gRPC AlterInbound (live add/remove) + atomic clients.json sync
- `wg.service.ts` — SSH to Server A: keypair gen, peer management, syncconf
- `ssh.ts` — auto-reconnecting ssh2 connection pool
- `charts.service.ts` — chartjs-node-canvas traffic PNG
- `qr.service.ts` — QR code PNG for VLESS URIs
- `system.service.ts` — CPU/RAM/disk/uptime via /proc + SSH
- `metrics.cache.ts` — 20s TTL cache for system.service calls (prevents throughput delta double-read)
- `ip-info.service.ts` — ISP lookup via ip-api.com batch endpoint, in-memory cache (re-lookup only on IP change)
- `xray-log.service.ts` — parses XRay access log (`/var/log/xray/access.log`) for last client IP per email tag; filters out `wg-clients@xray` and Server A relay IP

**Workers (background):**
- `traffic.worker.ts` — 10min: XRay gRPC stats (reset delta) + WG SSH stats → traffic_snapshots; collects client IPs (WG endpoint + XRay access log) → batch ISP lookup → `last_ip`/`last_ip_isp` columns
- `ttl.worker.ts` — 1h: auto-suspend expired clients
- `health.worker.ts` — 1min: SSH ping Server A → ping.store (used by alert worker)
- `updates.worker.ts` — 12h: apt-check on A+B, alert if security updates > 0
- `quota.worker.ts` — 1min: enforce daily/monthly quotas, daily/monthly reset
- `rollup.worker.ts` — nightly: move old snapshots → *_traffic_monthly tables
- `alert.worker.ts` — 30s (90s delayed start): evaluate all alert conditions (see § Alert System)

**Security:**
- `vpn-bot` system user, no shell, data in `/var/lib/vpn-bot/`
- ACL on `/etc/xray/keys/{reality.pub,shortid}` (read) and `/etc/xray/clients.json` (read+write)
- SSH keypair generated at deploy time, pubkey pushed to Server A authorized_keys
- Reality private key never leaves Server B

**Deploy:**
```bash
ansible-playbook playbooks/deploy_bot.yml \
  -e "bot_telegram_token=123:ABC bot_admin_id=987654321"
```

---

## 4️⃣ TMA (Telegram Mini App) Control Plane

```
Admin's Telegram
    │  opens Web App (Menu Button)
    ▼
Browser inside Telegram
    │  HTTPS → port 8444 (nginx, TLS)
    ▼
nginx (Server B :8444)
    │  proxy_pass → 127.0.0.1:3000
    ▼
Fastify HTTP server (inside bot process)
    │  TMA auth: HMAC-SHA256(initData, bot_token)
    │  REST API: GET/POST/PATCH/DELETE /api/clients
    │  POST /api/clients/:id/send-config
    ▼
ClientService (shared with bot menus)
    ├── xray.service.ts — atomic config.json write + xray-restart.path
    ├── wg.service.ts   — SSH to Server A
    └── bot.api.*       — sendMessage/sendPhoto to admin chat
```

**Stack:** React 18 + Vite 5 + TMA SDK, Fastify 4, pnpm workspace monorepo

**Monorepo structure** (`bot/`):
```
packages/
  shared/   — @vpn-relay/shared TypeScript types (Client, TrafficSnapshot, API types)
  server/   — Fastify API + grammy bot (current src/ moved here)
  web/      — React SPA built to packages/web/dist/ (served by Fastify static)
```

**Killer feature flow:**
1. Admin opens Web App from Menu Button in Telegram
2. Fills form, taps "Create Client" (Telegram MainButton)
3. MainButton shows progress spinner while keys are generated (1–2 s)
4. `POST /api/clients` → backend creates client, calls `sendConfigToChat()`
5. Bot sends `.conf` + QR codes to admin's Telegram chat
6. On success resolve → `WebApp.close()` — Web App closes
7. Admin sees config in chat — ready to share

**Auth:** Every API request carries `Authorization: tma <initData>`.
Server validates HMAC-SHA256 and checks `user.id === ADMIN_ID`.

**nginx setup (Server B):**
- Port `8444` (HTTPS) — does not conflict with XRay on `443`
- `certbot --nginx` obtains Let's Encrypt cert automatically
- UFW: `8444/tcp` + `80/tcp` (HTTP-01 challenge) opened

**Ansible role:** `roles/nginx_tma/` — validate → install → configure → certbot → verify

**Deploy:**
```bash
ansible-playbook playbooks/deploy_tma.yml \
  -e "tma_domain=vpn.example.com tma_certbot_email=admin@example.com"
```

**Client IP tracking:** ClientDetail shows `last_ip` + ISP name (from ip-api.com batch lookup).
ClientRow shows ISP as a compact label. IPs collected by traffic worker every 10 min from WG endpoint and XRay access log.

**stack.yml step 8:** TMA infra runs conditionally on `tma_domain | length > 0`.

---

## 5️⃣ Backup & Restore

```
Controller (local)
    │
    ├── backup.yml ──fetch──► Server A: wg-clients.key, .pub, .conf
    │                  └────► Server B: reality.key, .pub, shortid, clients.json, data.db
    │
    └── artifacts/backup/
          2026-03-01T12-00-00/
            server-a/   (WG keys + config)
            server-b/   (Reality keys + clients + bot DB)
          latest -> 2026-03-01T12-00-00/
```

**Backup:** `ansible-playbook playbooks/backup.yml` — timestamped snapshots, `latest` symlink.
Bot service stopped during DB copy for SQLite consistency.

**Restore:** `ansible-playbook playbooks/restore.yml` — defaults to `latest`, override with
`-e "backup_name=<timestamp>"`. Re-templates `config.json` from restored keys.

**Recovery flow:** `restore.yml` → `stack.yml` → all existing client configs continue working.

---

---

## 6️⃣ Alert System

```
alert.worker.ts (30s interval, 90s delayed start)
    │
    ├── ping.store      → cascade_down, cascade_degradation
    ├── systemctl       → service_dead_xray, service_dead_wg (via SSH)
    ├── metricsCache    → disk_full, network_saturation, cpu_overload, reboot_detected
    ├── DB queries      → abnormal_traffic, quota_warning
    └── openssl         → cert_expiry
```

**alert_settings table** — configurable per-alert: `enabled`, `threshold`, `threshold2` (duration), `cooldown_min`.
Seeded with defaults on first boot (`INSERT OR IGNORE` — never overwrites user changes on restart).

**alert_state table** — persists fire/clear timestamps across restarts for cooldown dedup.
Composite keys (`disk_full:a`, `quota_warning:{client_id}`) give independent cooldowns per target.

| Alert key | Severity | Default threshold | Source |
|-----------|----------|-------------------|--------|
| `cascade_down` | critical | 100% loss, 2 min | ping.store |
| `service_dead_xray` | critical | — | systemctl is-active xray |
| `service_dead_wg` | critical | — | SSH: systemctl is-active wg-quick@wg-clients |
| `disk_full` | critical | 90%, per server | metricsCache |
| `cascade_degradation` | warning | 30% loss, 5 min | ping.store |
| `network_saturation` | warning | 80% of channel, 15 min | metricsCache + channel_capacity |
| `cpu_overload` | warning | 95%, 10 min | metricsCache |
| `cert_expiry` | warning | 7 days | openssl x509 |
| `reboot_detected` | warning | uptime < 10 min | os.uptime() / SSH /proc/uptime |
| `abnormal_traffic` | info | 50 GB/hr, auto-suspend | DB: traffic_snapshots |
| `quota_warning` | info | 90% of monthly quota | DB: getQuotaUsageBatch |
| `channel_capacity` | config | 100 Mbps | read by network_saturation |

**API:** `GET /api/settings/alerts`, `PATCH /api/settings/alerts/:key`

**TMA Settings page:** grouped cards (Critical / Warning / Info) with toggle + expandable threshold fields. Saved on blur via React Query mutation.

---

## Требования к Ansible для bot-ready

Текущая архитектура уже совместима. Принципы при доработке playbooks:

1. Не добавлять `pause` / `vars_prompt` — бот не может вводить интерактивно
2. Предсказуемые пути артефактов: `artifacts/<type>/<name>.<ext>`
3. Относительные пути от корня репо, без хардкода абсолютных
4. Verify playbooks — warning-only (`failed_when: false`)
