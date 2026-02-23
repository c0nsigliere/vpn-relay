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
Client → Server A (wg-clients)
        → wg-uplink
        → Server B
        → Internet
```

### Server A:

* Интерфейс: `wg-clients`
* Подсеть клиентов: `10.66.0.0/24`
* Порт: `51888/udp`
* Policy routing:

  * table 200
  * ip rule from 10.66.0.0/24 lookup 200
  * default via wg-uplink
* SSH и основной default route НЕ ломаются.

### Server B:

* Интерфейс: `wg-uplink`
* Подсеть: `10.200.0.0/30`
* Порт uplink: `51821/udp`
* Делает MASQUERADE в WAN

---

## 2️⃣ XRay Access (Proxy plane)

```
Client → Server A (TCP relay 8443)
        → DNAT → Server B (XRay 443)
        → Internet
```

### Server A:

* TCP relay:

  * 8443/tcp → B:443/tcp (рекомендуется 443 если порт свободен — порт 8443 является DPI-маркером)
* Используется роль `relay`
* Никаких ключей XRay на A нет
* Только DNAT + MASQUERADE

### Server B:

* XRay (systemd)
* VLESS + Reality
* Порт: 443/tcp
* Без Docker
* Без Amnezia
* Reality private key хранится только на B

---

# 🧠 Протокол XRay

* Протокол: VLESS
* Transport: TCP
* Security: Reality
* encryption: none
* SNI: `www.cloudflare.com`
* Fingerprint: `chrome`
* Flow: по умолчанию отсутствует; рекомендуется `xtls-rprx-vision` для защиты от DPI (TLS-in-TLS splice)
* Users хранятся в `/etc/xray/users.json`
* Reality ключи:

  * `/etc/xray/keys/reality.key`
  * `/etc/xray/keys/reality.pub`
  * `/etc/xray/keys/shortid`

---

# 🧩 Репозиторий Ansible

## Роли

### roles/wg_cascade

* Управляет A и B
* Генерация ключей
* Обмен pubkey
* Routing
* Firewall
* Services
* Verify
* Memory parser (/proc/meminfo)

### roles/xray_server

* Только Server B
* Установка XRay binary
* Генерация Reality ключей
* users.json
* systemd service
* Firewall allow 443
* Verify

### roles/relay

* Только Server A
* DNAT TCP
* MASQUERADE
* FORWARD rules
* UFW keep mode
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

Если:

* MemAvailable < 128MB → WARN
* SwapTotal == 0 → WARN

Не падает, только предупреждает.

---

### playbooks/add_client.yml

Добавляет WireGuard клиента:

* генерит ключи
* пушит pubkey на A
* генерит `artifacts/clients/<name>.conf`

---

### playbooks/add_xray_user.yml

Добавляет XRay пользователя:

* генерит UUID
* обновляет `/etc/xray/users.json`
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
* port = 8443
* pbk = reality public key
* sid = shortId
* sni = [www.cloudflare.com](http://www.cloudflare.com)
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
  server_a
  server_b

xray_servers:
  server_b

relay_servers:
  server_a
```

---

# ⚙️ Переменные

## Shared (group_vars/all.yml)

* manage_ufw
* wan_if
* maintenance flags

## Cascade

* wg_clients_net
* wg_clients_addr_a
* wg_clients_port
* wg_uplink_net
* wg_uplink_addr_a
* wg_uplink_addr_b
* wg_uplink_port_b
* ip_b_public (может вычисляться из hostvars server_b)

## Relay

* ip_b (желательно вычислять из hostvars server_b)
* port_a_tcp = 8443
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
ansible-playbook playbooks/add_client.yml -e "client_name=..."
```

Добавить XRay пользователя:

```
ansible-playbook playbooks/add_xray_user.yml -e "user_name=..."
```

---

# 📌 Текущее состояние

* WireGuard cascade работает
* Relay TCP работает
* Native XRay развёрнут (systemd, без Docker)
* Amnezia/Docker полностью удалены из кодовой базы
* Архитектура переходит к single-entry stack
* DPI hardening: рекомендуется порт 443 вместо 8443 на relay, гео-нейтральный SNI вместо cloudflare, flow `xtls-rprx-vision`
* Планируется возможный control-plane (позже)
* Возможен Telegram бот для выдачи конфигов (не реализован)
