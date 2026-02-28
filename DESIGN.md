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

## Shared (group_vars/all.yml)

* server_b_public_ip
* port_a_tcp (443)
* port_b_tcp (443)
* manage_ufw
* wan_if
* maintenance flags

## Cascade

* wg_clients_net
* wg_clients_addr_a
* wg_clients_port
* xray_tproxy_port (default: 12345)
* xray_tproxy_table (default: 100)

## Relay

* server_b_public_ip (из group_vars/all.yml — канонический адрес B)
* port_a_tcp = 443
* port_b_tcp = 443

## XRay

* xray_port = 443
* xray_reality_dest
* xray_reality_server_name
* xray_reality_fingerprint
* xray_version
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

**Stack:** TypeScript + Node.js 20, grammy, better-sqlite3, ssh2, @grpc/grpc-js

**Bot source:** `bot/src/` — deployed to `/opt/vpn-bot` on Server B via Ansible role `telegram_bot`

**Services:**
- `xray.service.ts` — gRPC AlterInbound (live add/remove) + atomic clients.json sync
- `wg.service.ts` — SSH to Server A: keypair gen, peer management, syncconf
- `ssh.ts` — auto-reconnecting ssh2 connection pool
- `charts.service.ts` — chartjs-node-canvas traffic PNG
- `qr.service.ts` — QR code PNG for VLESS URIs
- `system.service.ts` — CPU/RAM/uptime via /proc + SSH

**Workers (background):**
- `traffic.worker.ts` — 10min: XRay gRPC stats (reset delta) + WG SSH stats → traffic_snapshots
- `ttl.worker.ts` — 1h: auto-suspend expired clients
- `health.worker.ts` — 1min: SSH ping Server A, alert after 3 failures
- `updates.worker.ts` — 12h: apt-check on A+B, alert if security updates > 0

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

## Требования к Ansible для bot-ready

Текущая архитектура уже совместима. Принципы при доработке playbooks:

1. Не добавлять `pause` / `vars_prompt` — бот не может вводить интерактивно
2. Предсказуемые пути артефактов: `artifacts/<type>/<name>.<ext>`
3. Относительные пути от корня репо, без хардкода абсолютных
4. Verify playbooks — warning-only (`failed_when: false`)
