# VPN Stack — XRay VLESS+Reality with Optional WireGuard Cascade

## Project Goal

Ansible-managed VPN stack supporting two deployment modes from the same codebase:

| Mode | Servers | Use case |
|------|---------|----------|
| **Standalone** | 1 VPS | Direct VLESS+Reality connection. Simplest setup. |
| **Cascade** | 2 VPS (entry + exit) | WireGuard cascade + TCP relay through an entry node in a censored region. Bypasses DPI/UDP blocking. |

Both modes share the same Ansible roles, Telegram bot, and TMA web app.

### Standalone Mode

Single server running XRay VLESS+Reality + bot + TMA. Clients connect directly.

### Cascade Mode

Two servers:
* **Entry node** — in a censored region. Runs WireGuard + XRay TPROXY + TCP relay.
* **Exit node** — abroad. Runs XRay VLESS+Reality, bot, TMA.

The system:
1. Bypasses DPI and UDP blocking (TPROXY wraps WG traffic in VLESS+Reality).
2. Supports WireGuard VPN (cascade entry→exit) and direct VLESS (relay or direct).
3. Is fully managed via Ansible with optional Telegram bot and web admin.
4. Is portable (replacing either node doesn't break the architecture).
5. Auto-generates client configs (WG .conf, VLESS URIs + QR codes).

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

**Phase 3 (WG cascade over Hy2) — per-client uplink transport, при `hy2_uplink_password`:**
тот же TPROXY-путь, но транспорт A→B **выбирается для каждого WG-клиента**
(`wg_cascade_transport` = `xray` | `hy2`). На A всегда присутствуют оба outbound'а:
`proxy-out` (VLESS) и `hy2-uplink` (SOCKS `127.0.0.1:1080` → sing-box-КЛИЕНТ на A,
release-бинарь роли `relay`, Hy2-outbound на `hy2_port/udp` Server B, статический юзер
`wg-clients@hy2`, валидный LE-серт — без `insecure`). XRay роутит **по source-IP**: TPROXY
сохраняет tunnel-IP клиента (10.66.0.x), правило `source: [ip/32] → hy2-uplink` выбирает
Hy2 для конкретного клиента; дефолт — `proxy-out` (VLESS).

Ansible кладёт БАЗОВЫЙ конфиг A (оба outbound'а + дефолт `proxy-out`); **бот (на B)
переписывает ТОЛЬКО `routing.rules` конфига A по SSH** — вставляет per-client
`source`-правила для клиентов с транспортом `hy2` и рестартит XRay на A. Outbound'ы
(с Reality-pubkey и UUID) — Ansible-owned, бот их не трогает и секретов на A не добавляет.
Правила active-agnostic (у suspended-клиента peer снят, правило инертно) → suspend/resume
не рестартит A. Синхронизация — на create/edit-transport/delete WG-клиента и на старте бота
(`xray-uplink.service.ts`). `proxy-out` сохранён для мгновенного отката всего каскада на VLESS.

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
* Клиенты хранятся в SQLite DB бота (`/var/lib/vpn-bot/data.db`); `config.json` перегенерируется из БД
* wg-uplink peer (`wg-clients@xray`) — единственная статическая запись в `config.json` (UUID из env)

---

## 2️⃣.5 Hysteria 2 Access (Direct QUIC plane)

```
Client → Server B :443/udp (sing-box Hysteria 2, salamander obfs)
        → direct outbound → Internet
```

Second, independent data-plane on the exit node, co-existing with XRay
(XRay 443/tcp, Hy2 443/udp — TCP and UDP on the same port do not conflict).
Available direct (client → B) and, in cascade mode, via a UDP relay through
Server A (see §2.6). Strong against DPI throughput-shaping because QUIC +
salamander obfuscation hides the handshake.

* Service: `sing-box` (systemd), Hysteria 2 inbound, `443/udp`
* Built **from source** with `with_v2ray_api` (release binaries omit it) — needed
  for per-user traffic stats. Verified via `sing-box version` → `Tags:`.
* TLS: real Let's Encrypt certificate (SNI = `hy2_domain`); no `insecure=1` in
  issued URIs. obfs password in `/etc/sing-box/obfs.pw` (generated once).
* Clients live in the bot's SQLite DB (`type='hysteria2'`, `hy2_password`);
  `/etc/sing-box/config.json` `users` + `experimental.v2ray_api.stats.users`
  are rebuilt from the DB on every mutation and on bot startup.
* **Stats over gRPC:** sing-box registers the stats service as
  `v2ray.core.app.stats.command.StatsService` (v2ray v5 name), which the xray
  CLI cannot reach — so the bot queries it with a native `@grpc/grpc-js` client
  (`proto/v2ray-stats.proto`). In-memory counters reset on restart (parity with
  XRay).
* URI: `hysteria2://<pw>@<host>:443/?sni=<domain>&obfs=salamander&obfs-password=<obfs>#<tag>`
  (canonical slash before `?`).

---

## 2️⃣.6 Hysteria 2 Relay (UDP relay plane — phase 4)

```
Client → Server A :port_a_udp/udp
        → DNAT + MASQUERADE (pure L4, no decryption)
        → Server B :hy2_port/udp (sing-box Hysteria 2) → Internet
```

The UDP mirror of the VLESS relay (§2️⃣). A fifth connection method — additive,
not a replacement: a Hy2 client can use its direct URI and its relay URI in
parallel. The QUIC/TLS session terminates on B, so the Let's Encrypt cert stays
valid and no `insecure` appears in the relay URI. Server A stays a dumb pipe: no
Hy2 credentials, no cert, no sing-box.

* **Ansible (`roles/relay`):** UDP `DNAT port_a_udp → server_b:port_b_udp` +
  `MASQUERADE`, in both firewall modes (`ufw_keep.yml` `*nat` block / `iptables.yml`),
  gated on `hy2_enabled`. `nf_conntrack_udp_timeout_stream` is raised so long-lived
  QUIC sessions survive between keepalives. No MSS clamping (QUIC does PMTUD).
* **Bot URIs:** `hysteriaService.generateUris()` returns `{ direct, relay }` —
  `direct` dials `hy2_host:hy2_port`, `relay` dials `SERVER_A_HOST:port_a_udp`;
  identical creds/obfs/SNI, only host:port and `#tag` differ. `relay` is `null` in
  standalone. Both are shown/QR'd on create and on "Get Config".
* **Route + real IP:** the sing-box log gives the source IP per client; if it is
  Server A's IP, the connection is relay and its masqueraded UDP source port is
  correlated against `conntrack -L -p udp --dst-nat` on A to recover the real
  client IP (mirror of the VLESS-relay TCP correlation). `last_connection_route`
  becomes `direct` or `relay`; stats/quotas/alerts are unchanged (all accounted on
  B, keyed by user name, route-agnostic).

---

# 🧠 Протокол XRay

* Протокол: VLESS
* Transport: TCP
* Security: Reality
* encryption: none
* SNI: `www.googletagmanager.com`
* Fingerprint: `chrome`
* Flow: `xtls-rprx-vision` (TLS-in-TLS splice, DPI protection)
* Clients хранятся в SQLite DB бота; `config.json` генерируется из БД при каждом изменении
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
* config.json (generated from bot DB at runtime; Ansible seeds initial template)
* systemd service
* Firewall allow 443
* Verify

### roles/singbox_server

* Только Server B (exit / standalone)
* **Собирает sing-box из исходников** с `with_v2ray_api` (pinned Go toolchain)
* Генерирует salamander obfs-пароль (`/etc/sing-box/obfs.pw`, once)
* `config.json` (Hy2 inbound + v2ray_api; `users` заполняет бот из БД —
  поэтому изменение шаблона нотифицирует не только `restart sing-box`, но и
  `restart vpn-bot` (`systemctl try-restart`), чтобы бот сразу вернул клиентов
  в свежий scaffold; то же самое в `xray_server` для `/etc/xray/config.json`)
* Firewall allow `hy2_port`/udp
* systemd service + certbot deploy-hook (рестарт при renewal)
* Verify (config check, service, udp listen, `with_v2ray_api` tag, cert)

### roles/tls_cert

* Выпуск Let's Encrypt сертификатов через `certbot --standalone` (HTTP-01, :80)
* Домены — дедуплицированное объединение `tma_domain` + `hy2_domain`
* Verify ассертит, что ничего не биндит :80 постоянно (иначе renewal сломается)
* `roles/nginx_tma` теперь только **потребитель** серта (слушает лишь `tma_https_port`)

### roles/relay

* Только Server A
* DNAT TCP (`port_a_tcp` → B:`port_b_tcp`)
* **DNAT UDP (`port_a_udp` → B:`port_b_udp`)** — Hy2 relay, phase 4, gated on
  `hy2_enabled`; в обоих режимах firewall (`ufw_keep.yml` `*nat` / `iptables.yml`).
  `nf_conntrack_udp_timeout_stream` поднят для долгих QUIC-сессий
* MASQUERADE + FORWARD rules (TCP + UDP)
* UFW keep mode
* **XRay TPROXY client** — устанавливает XRay binary, пишет config из шаблона
  `xray-uplink-client.json.j2` (TPROXY inbound + VLESS+Reality outbound)
  Читает Reality pubkey с Server B через delegate_to
* Verify

### roles/maintenance

* fail2ban (SSH brute-force protection, `banaction=ufw`, SSH jail only)
* VM sysctl tuning (swappiness, vfs_cache_pressure, min_free_kbytes — tiered by RAM)
* systemd DefaultTasksMax (tiered by RAM — fork bomb protection)
* journald rate limiting (200 burst / 30s — throttle log spam)
* unattended-upgrades with systemd resource limits (MemoryHigh/MemoryMax tiered by RAM)
* update / upgrade
* reboot-if-needed
* on-demand maintenance agent (`/usr/local/sbin/vpn-maintenance`, тег `agent`) — root-хелпер,
  который бот дёргает для apt/reboot по кнопке (см. § On-demand Maintenance)
* health (ip_forward, rp_filter, UFW, fail2ban jail status)

---

# 📂 Playbooks (финальная модель)

## Основные

### playbooks/stack.yml

Единственный entrypoint для установки с нуля.

Порядок:

1. maintenance (update/upgrade)
2. swap (all hosts — если нет)
3. wg_cascade (A+B)
4. xray_server (B)
5. tls_cert (optional, if `tma_domain` or `hy2_domain` set)
6. singbox_server (optional, if `hy2_enabled`)
7. relay (A)
8. verify_all
9. bot (optional, if `bot_telegram_token` set)
10. tma (optional, if `tma_domain` set)

---

### playbooks/verify_all.yml

Проверяет:

* wg handshakes
* ip rule table 200
* wg-uplink default route
* relay DNAT rules
* xray service active
* port 443 listening on B
* sing-box active + udp `hy2_port` listen + `with_v2ray_api` (non-fatal, when `hy2_enabled`)
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

### playbooks/backup.yml

Бэкап критического состояния серверов в `artifacts/backup/<timestamp>/`:
* WG ключи и конфиг с Server A
* Reality ключи и БД бота (`data.db`) с Server B
* Symlink `latest` → текущий бэкап

### playbooks/restore.yml

Восстановление из бэкапа:
* По умолчанию `latest`, override через `-e "backup_name=..."`
* Re-template config.json после восстановления ключей
* После restore запустить `stack.yml` для полной рекенфигурации

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
* server_a_country / server_b_country — 2-letter ISO codes (optional, auto-resolved via GeoIP at deploy)
* xray_port (8443)
* port_a_tcp (443)
* port_b_tcp (derives from xray_port)
* port_a_udp (443) — Hy2 relay entry on A (phase 4; only when hy2_enabled)
* port_b_udp (derives from hy2_port) — Hy2 relay target on B (phase 4)
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
* **SSH hardening:** key-only auth, `MaxStartups 3:30:10`, `LoginGraceTime 20`
* **fail2ban:** SSH jail (3 retries / 5 min / 1h ban), `banaction=ufw`
* **VM tuning:** sysctl swappiness/vfs_cache_pressure/min_free_kbytes tiered by RAM (<1GB aggressive, 1-4GB moderate, >4GB trusts kernel defaults)
* **apt resource limits:** systemd cgroup MemoryHigh/MemoryMax on `apt-daily-upgrade` (5 tiers: <1GB to >16GB)
* **systemd DefaultTasksMax:** tiered by RAM (256/<2GB, 512/2-4GB, 2048/>4GB) — fork bomb protection (general-purpose non-container baseline; container-heavy hosts may need per-service override)
* **journald rate limiting:** 200 burst/30s per service unit

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

Клиенты управляются через Telegram бота / TMA (DB — единственный source of truth).

### WireGuard: desired-state пиры

Инвариант «БД — источник истины» для WG раньше выполнялся только на словах. XRay,
sing-box и cascade-роутинг пересобираются из БД при каждом старте; WG-пиры же жили
исключительно как `# BEGIN/END CLIENT` блоки, которые мутации правили на месте
(append / `sed -i` / `sed` для переименования). Отсюда два следствия:

* восстановленная БД **не воскрешала** удалённого WG-клиента — ничто не сверяло conf
  на A со строками таблицы;
* `suspendClient` убирал пира только из live-состояния, оставляя блок в conf, поэтому
  `wg syncconf` при следующем add/remove **воскрешал заблокированного клиента**.

Обе проблемы — отсутствие одного примитива. `wgService.syncPeersFromDb()` рендерит
всю пир-область из строк БД, побайтово сохраняя Ansible-управляемую секцию
`[Interface]` (включая `PrivateKey` и TPROXY `PostUp`), и затем приводит live-состояние
в соответствие. Заблокированные клиенты **рендерятся** (блок — долговременная запись о
выделенном IP) и снимаются из live-состояния после `syncconf` — так баг с воскрешением
закрыт конструктивно.

Инкрементальные `wg set` при add/remove сохранены: полный `syncconf` на каждую мутацию
дёргал бы сессии всех пиров ради изменения одного.

**Порядок обязателен:** `client.service` вызывает синк **после** записи в БД — там же,
где уже вызывает `xrayService.syncConfigAndRestart()`. Вызов до записи отрендерил бы
состояние «до мутации».

**Валидация строк** (`name` / `wg_pubkey` / `wg_ip`) — обязательна, потому что после
restore эти значения приходят из загруженного файла. Плохая строка пропускается и
логируется, но не роняет синк: одна битая запись не должна лишать связи всех
остальных. Конфиг едет на A в base64 и кладётся через temp + atomic `mv` — содержимое
файла никогда не попадает в шелл-строку.

**Выделение IP** идёт из `union(БД, conf-на-A, in-flight резервации)`. Раньше читался
только conf — под desired-state это неверное направление: сразу после restore conf ещё
не пересобран, и IP, уже принадлежащий записи в БД, был бы выдан повторно.

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
* Автоматические шифрованные бэкапы + restore из чата — реализованы (`backup.service`,
  `backup.worker`, `scripts/backup-decrypt.mjs`); WG-пиры переведены на desired-state

---

## 3️⃣ Telegram Bot Control Plane

```
Admin (Telegram)
    │
    ▼
Bot (Server B) ─── gRPC :10085 ──► XRay (local)
    │                                  (HandlerService + StatsService)
    │                                  config.json rebuilt from SQLite DB
    │
    └─── SSH ed25519 ──────────────► Server A
                                       wg set / wg syncconf / wg show dump
```

**Stack:** TypeScript + Node.js 20 + pnpm workspace, grammy, better-sqlite3, ssh2, Fastify

**Bot source:** `bot/packages/server/src/` — deployed to `/opt/vpn-bot` on Server B via Ansible role `telegram_bot`

**Services:**
- `xray.service.ts` — reads active clients from DB, rebuilds `config.json` directly + xray-restart.path trigger
- `wg.service.ts` — SSH to Server A: keypair gen, peer management, syncconf
- `ssh.ts` — auto-reconnecting ssh2 connection pool
- `updates.service.ts` — fetches upgradable packages (`apt list --upgradable`) and changelogs (batched `apt-get changelog`) from both servers
- `openai.service.ts` — single-function wrapper for OpenAI chat completions (native fetch, no npm dep). Summarizes changelogs into one-liners + CVE extraction. Returns null on any error (graceful degradation)
- `charts.service.ts` — chartjs-node-canvas traffic PNG
- `qr.service.ts` — QR code PNG for VLESS URIs
- `system.service.ts` — CPU/RAM/disk/uptime via /proc + SSH
- `metrics.cache.ts` — 20s TTL cache for system.service calls (prevents throughput delta double-read). `invalidate(server)` drops a slot after an update so the "N upd" badge zeroes immediately (promise-identity guard keeps an in-flight fetch from re-pinning stale data)
- `maintenance.service.ts` — on-demand update/reboot: starts a job (trigger file on B, `systemd-run` on A), probes the root helper's state file, and reconciles jobs after a restart via `boot_id` (see § On-demand Maintenance)
- `ip-info.service.ts` — ISP lookup via ip-api.com batch endpoint, in-memory cache (re-lookup only on IP change)
- `xray-log.service.ts` — parses XRay access log (`/var/log/xray/access.log`) for last client IP per email tag; filters out `wg-clients@xray` and Server A relay IP

**Utils:**
- `logger.ts` — structured logger with levels (`debug`/`info`/`warn`/`error`), module prefixes, and `LOG_LEVEL` env gate. `error`/`warn` → stderr (journald priority 3-4); `info`/`debug` → stdout. `logOnError()` helper replaces `.catch(() => {})` patterns.

**Workers (background):**
- `traffic.worker.ts` — 10min: XRay gRPC stats (reset delta) + WG SSH stats → traffic_snapshots; collects client IPs (WG endpoint + XRay access log) → batch ISP lookup → `last_ip`/`last_ip_isp` columns
- `ttl.worker.ts` — 1h: auto-suspend expired clients
- `health.worker.ts` — 1min: SSH ping Server A → ping.store (used by alert worker)
- `updates.worker.ts` — 12h: enriched package update alerts with changelogs and optional AI summaries (OpenAI gpt-4o-mini). 3 tiers: Tier 1 (AI summaries + CVEs), Tier 2 (package list), Tier 3 (bare count fallback). Integrated with alert system (`updates_pending` key). Hash-based dedup avoids redundant changelog/AI calls.
- `quota.worker.ts` — 1min: enforce daily/monthly quotas, daily/monthly reset
- `rollup.worker.ts` — nightly: move old snapshots → *_traffic_monthly tables
- `alert.worker.ts` — 30s (90s delayed start): evaluate all alert conditions (see § Alert System)
- `maintenance.worker.ts` — 3s (no-op unless a job is in flight): mirror the root helper's job state into the DB, stall detection, reboot tracking by `boot_id`, Telegram transitions. Reconciles jobs left in flight by the previous shutdown before its first tick (see § On-demand Maintenance)

**Security:**
- `vpn-bot` system user, no shell, data in `/var/lib/vpn-bot/`
- ACL on `/etc/xray/keys/{reality.pub,shortid}` (read) and `/etc/xray/config.json` (read+write); when Hy2 is enabled, same pattern on `/etc/sing-box/` (obfs.pw read, config.json read+write). Set by the `telegram_bot` role and re-applied by `xray_server`/`singbox_server` after templating config.json (the template module replaces the inode, dropping ACLs)
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
    ├── xray.service.ts — rebuild config.json from DB + xray-restart.path
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

Два пути, намеренно. **Бот** — автоматический горячий путь (ежедневно, off-site,
зашифровано). **Плейбуки** — холодный операторский путь и исполнитель DR.

### Горячий путь (бот на Server B)

```
 по расписанию ──► backup.worker ──► backupService.runBackup()
 (умолчание:            │
  Пн 03:00Z)            │  1. db.backup() → staging/data.db   (консистентный снимок под WAL)
                       │  2. xray/reality.{key,pub}, shortid; singbox/obfs.pw (если hy2)
                       │  3. ssh A: cat wg-clients.key       (best-effort, 10s)
                       │  4. manifest.json (host, label, counts, reality_pub)
                       │  5. tar.gz → AES-256-GCM(scrypt(passphrase))
                       │  6. /var/lib/vpn-bot/backups/ (ротация, keep N)
                       │  7. sendDocument → чат админа
                       └── ошибка → backup_failed; alert.worker следит за backup_stale
```

Формат контейнера: `magic "VPNRB1"(6) | salt(16) | iv(12) | ciphertext | tag(16)`,
ключ = `scryptSync(passphrase, salt, 32)`, `{N:16384, r:8, p:1}`.

**Почему бандл, а не только БД:** без `reality.key` и `obfs.pw` восстановление с нуля
регенерирует ключи → у всех выданных URI меняются `pbk` / `obfs-password` → все
клиенты умирают. `wg-clients.key` — то же самое для WG (приватные ключи клиентов
нигде не хранятся, серверного ключа + pubkey'ев из БД достаточно).

**Почему passphrase лежит внутри бандла:** это то, чем бандл *зашифрован* — тот, кто
не может расшифровать, ничего и не узнает. Выигрыш: восстановленная нода продолжает
читать свои **старые** бандлы без переинициализации секретов.

**Три статуса.** `success` — бандл записан локально И доставлен. `degraded` — записан,
но не доставлен (бэкап есть, off-site копии нет); считается за «бэкап есть» для
`backup_stale`, но поднимает `backup_failed`. `failed` — валидного бандла нет.
Ротация привязана к *существованию* бандла, не к доставке, и сортирует по метке
времени **из имени файла** (не mtime — его переписывают rsync/cp/restore).

### Расписание (`services/backup.schedule.ts`)

Живёт в таблице `app_settings` и редактируется в рантайме — карточка Backup в TMA
(пресеты Daily / Every 3 days / Weekly + произвольные 1–30 дней + час UTC + вкл/выкл)
и подменю `Settings → 🗓 Schedule` в боте. Переменные Ansible только **сидируют**
значения при первом старте ноды (`INSERT OR IGNORE`), дальше источник истины — БД:
тот же контракт, что у `alert_settings`. Исключение — `backup_retention`, он читается
из `.env` при каждом старте и остаётся ansible-only.

**Сетка слотов — абсолютная и заякоренная**, а не «каждые N дней от последнего
запуска». Интервал от предыдущего запуска ползёт вперёд при каждом опоздании, а
рестарт деплоя рядом со слотом может выстрелить дважды. Якорь — 1970-01-05
(понедельник), поэтому недельный интервал попадает на понедельники, а не на четверг,
который навязал бы epoch; при интервале 1 якорь не влияет ни на что.

Догон при старте — **по слотам**, не по возрасту: «последний успех старше 25ч»
пропускает случай «бэкап в 03:00, хост лежал 02:50–03:45» (успеху всего 24ч45м) и
молча растягивает разрыв до 48 часов. При недельном расписании возрастная проверка
ломается ещё грубее — гоняла бы бэкап каждый день.

Изменение расписания вызывает `rescheduleBackups()`: взведённый таймер при недельной
каденции может быть на шесть дней вперёд, и без пересборки правка выглядела бы как
no-op.

### Restore из бота

```
админ шлёт .enc в чат → getFile (≤19 MB) → decrypt (GCM = целостность+подлинность)
  → распаковка со строгим allowlist'ом имён/типов/размеров → валидация
     (manifest.format, PRAGMA integrity_check, COUNT(*) FROM clients, reality_pub)
  → кнопки подтверждения → снимок текущей БД в pre-restore-<ts>.db
  → teardown в порядке F8 → rm -f data.db-wal/-shm → rename → exit(0)
  → systemd поднимает бота → стартовые синки восстанавливают data plane
```

Бот применяет **только БД** — ключи пишет root (у бота нет прав на запись в
`/etc/xray/keys`, и это правильный раздел: при restore на том же сервере ключи уже
верные, а при мёртвом сервере бота ещё нет). Ключевая зависимость: **стартовый синк
WG-пиров** (§ WireGuard desired-state) — без него восстановленная БД не воскресила бы
удалённого WG-клиента.

`lifecycle.ts` — реестр teardown-шагов: restore обязан выполнить ту же
последовательность, что и SIGTERM, но из сервиса, который не может импортировать
`index.ts` без цикла.

### Холодный путь (контроллер)

```
Controller (local)
    │
    ├── backup.yml ──fetch──► Server A: wg-clients.key, .pub, .conf
    │                  └────► Server B: reality.key, .pub, shortid, obfs.pw,
    │                                   backup.passphrase, data.db
    │
    └── artifacts/backup/
          2026-03-01T12-00-00/{server-a,server-b}/
          latest -> 2026-03-01T12-00-00/
```

`backup.yml` останавливает `vpn-bot` вокруг копирования и **падает**, если после
остановки остался `data.db-wal` (значит прошлое выключение было грязным и `data.db`
неполон). Это гарантирует, что каждый артефакт — самодостаточный одиночный файл, и
`restore.yml` никогда не разбирает пары DB+WAL.

`restore.yml` принимает **две раскладки**: снимок от `backup.yml` и распакованный
бандл бота. `wg-clients.pub` выводится из приватного ключа, если отсутствует;
`wg-clients.conf` — производные данные (пиры пересобирает бот). После копирования
ключей **переприменяет ACL** — `ansible.builtin.copy` подменяет inode и стирает их.

### Новые алерты

| Ключ | Порог по умолчанию | Смысл |
|------|--------------------|-------|
| `backup_failed` | cooldown 360 мин | Прогон упал или бандл не ушёл off-site. Снимается явно при следующем успехе |
| `backup_stale` | grace 12 ч, cooldown 720 | Давно не было успешных прогонов. Отдельный сторож в `alert.worker` — ловит сломанное расписание, когда прогона нет и ошибки тоже нет. **`threshold` — это запас поверх интервала**, а не абсолютный возраст: фиксированные 36 ч срабатывали бы каждую неделю, как только расписание станет недельным |

---

## 6️⃣ Alert System

```
alert.worker.ts (30s interval, 90s delayed start)
    │
    ├── ping.store      → cascade_down, cascade_degradation
    ├── systemctl       → service_dead_xray, service_dead_wg (via SSH)
    ├── metricsCache    → disk_full, network_saturation, cpu_overload, reboot_detected, reboot_required
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
| `reboot_required` | warning | file exists, 12h cooldown | metricsCache.rebootRequired |
| `abnormal_traffic` | info | 50 GB/hr, auto-suspend | DB: traffic_snapshots |
| `quota_warning` | info | 90% of monthly quota | DB: getQuotaUsageBatch |
| `updates_pending` | info | — (12h cooldown) | updates.worker: apt list --upgradable |
| `channel_capacity` | config | 100 Mbps | read by network_saturation |

**API:** `GET /api/settings/alerts`, `PATCH /api/settings/alerts/:key`

**TMA Settings page:** grouped cards (Critical / Warning / Info) with toggle + expandable threshold fields. Saved on blur via React Query mutation.

---

## 7️⃣ On-demand Maintenance (Update / Reboot from bot & TMA)

Update и Reboot по кнопке — из TMA (`/server/:id`) и из inline-меню бота. Кнопка запускает
`/usr/local/sbin/vpn-maintenance` — императивный двойник `roles/maintenance/tasks/update.yml`
(`apt-get update` → `dist-upgrade` c `autoremove: false` → `clean`). Ansible остаётся источником
истины для эталонной архитектуры; гонка между ними безопасна — обе идут через apt lock.

**Ключевая проблема: бот на B непривилегированный** (`NoNewPrivileges=true`, `ProtectSystem=strict`,
sudoers в репозитории нет) и не может запустить apt. Отсюда два разных канала эскалации:

```
Server B (свой хост, бот без прав)          Server A (удалённый, бот = root по SSH)
─────────────────────────────────           ─────────────────────────────────────
bot → /run/vpn-maintenance/req-<action>      bot → ssh: systemd-run --unit=vpn-maint-<id>
        │  (tmpfs, владелец vpn-bot)                  │  --setenv=VPN_MAINT_JOB=<id>
        ▼                                             ▼
vpn-maintenance-<action>.path                 transient unit на системном менеджере A
        │  PathExists=                                │
        ▼                                             │  detach обязателен: при обрыве SSH
vpn-maintenance-<action>.service              ───────┘  sshd убил бы apt посреди dpkg
  Type=oneshot, TimeoutStartSec=3600
        │
        ▼
/usr/local/sbin/vpn-maintenance <action>   (root)
        │
        └──► /var/lib/vpn-maintenance/jobs/<id>.{json,log}   ← persistent, root-only
```

**Действие закодировано в имени файла-триггера и в `ExecStart` юнита, никогда в содержимом
файла.** Allowlist обеспечивается топологией systemd — root не парсит строку действия,
пришедшую от непривилегированного процесса. Единственное, что root читает из bot-writable
файла, — 32-hex job id, открытый с `O_NOFOLLOW` (атомарный отказ по симлинку) и отфильтрованный
регуляркой.

**Две директории — намеренно:**
- `/run/vpn-maintenance` (**tmpfs**) — триггеры. Триггер, переживший ребут, повторно поднял бы
  `.path`-юнит при загрузке → для `reboot` это **цикл перезагрузок**. Хелпер к тому же съедает
  триггер первым действием, поэтому его падение не оставляет «взведённый» файл.
- `/var/lib/vpn-maintenance/jobs/` (**диск**) — статус переживает ребут. Именно это позволяет
  отчитаться о перезагрузке **собственного** хоста: бот умирает вместе с сервером, а после
  старта сверяет `boot_id` из файла с текущим.

**`boot_id` — несущая конструкция.** Он отличает «задача всё ещё идёт» от «машина
перезагрузилась под задачей»: для A worker'ом (опрос), для B — startup-реконсиляцией.

**`maintenance_jobs`** (DB) — зеркало файла состояния плюс «кто и когда попросил».
Частичный уникальный индекс `ON (server_id) WHERE status IN ('queued','running','rebooting')` —
и есть настоящая гарантия «одна задача на сервер»: переживает рестарт бота, не требует
in-memory мьютекса и одинаково закрывает оба входа (TMA и меню бота).

**Защита от двойного нажатия — 5 слоёв:** disabled-кнопки в UI → перепроверка в обработчике
меню → **уникальный индекс (HTTP 409)** → `flock -n` на уровне ОС → replay guard в хелпере
(job id, дошедший до терминального статуса, не запускается повторно).

**Подавление алертов.** Пока задача активна (и 3 минуты после — `wg-quick` может ещё
подниматься), для этого сервера глушатся `cascade_down`, `cascade_degradation`,
`service_dead_wg/xray/singbox`, `cpu_overload`; `reboot_detected` глушится по `reboot_at`
в окне 15 минут. **`disk_full` не глушится намеренно** — забитый `/boot` это ровно тот отказ,
который апгрейд и вскрывает.

**Сервисы/воркеры:** `services/maintenance.service.ts` (старт, probe, реконсиляция),
`workers/maintenance.worker.ts` (тик 3с, зеркалирование, stall detection, уведомления;
реконсиляция — внутри фабрики до первого тика).

**API:** `POST /api/servers/:id/maintenance` → 202 (400/409/502), `GET /api/servers/:id/maintenance`
→ `{active, last}` (**только БД** — TMA опрашивает раз в 2с, SSH тут был бы штормом).

**Ansible:** хелпер — `roles/maintenance` (тег `agent`, ставится на A и B), path-юниты —
`roles/telegram_bot` (роль, создающая непривилегированный принципал, владеет его каналом
эскалации). `telegram_bot` импортирует `maintenance/tasks/agent.yml`, поэтому `deploy_bot.yml`
не может поставить юниты без скрипта за ними.

---

## Требования к Ansible для bot-ready

Текущая архитектура уже совместима. Принципы при доработке playbooks:

1. Не добавлять `pause` / `vars_prompt` — бот не может вводить интерактивно
2. Предсказуемые пути артефактов: `artifacts/<type>/<name>.<ext>`
3. Относительные пути от корня репо, без хардкода абсолютных
4. Verify playbooks — warning-only (`failed_when: false`)
