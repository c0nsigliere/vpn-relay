# TODO

## Completed

- [x] **Unify IP variable** — removed `ip_b_public` from `inventory/group_vars/all.yml` and `DESIGN.md`; canonical variable is `server_b_public_ip`

- [x] **Legacy cleanup** — remove Amnezia/Docker references from codebase
  - `roles/xray_server/tasks/validate.yml` — removed Docker takeover block and `xray_takeover_443` variable
  - `roles/wg_cascade/tasks/validate.yml` — softened 51820 hard-fail (removed Amnezia references)
  - `playbooks/cascade.yml` — removed pre-tasks that clean legacy UDP relay iptables rules
  - `playbooks/cleanup_legacy_relay.yml` — deleted
  - `README.md` — removed Amnezia/Docker from diagram and cleanup section
  - `docs/troubleshooting.md` — removed Amnezia-specific sections
  - `roles/wg_cascade/templates/wg-uplink-b.conf.j2` — removed Amnezia comment
  - `roles/wg_cascade/defaults/main.yml` — removed Amnezia references from comments
  - `inventory/inventory.ini.example` — removed Amnezia comment
  - `inventory/group_vars/wg_cascade.yml.example` — removed Amnezia comment

## Priorities (in order)

1. ~~**Memory checks in verify_all.yml**~~ ✅ — added "Verify memory and swap (all hosts)" play
   - Reuses `roles/wg_cascade/tasks/memory.yml` via `include_tasks`
   - Warns on MemAvailable < 128 MB and SwapTotal == 0
   - Shows `free -h` and CPU/load averages

2. ~~**Create stack.yml**~~ ✅ — `playbooks/stack.yml` created with import_playbook chain
   - Order: maintenance → swap → cascade → xray → relay → verify_all

3. ~~**Update DESIGN.md**~~ ✅ — sync with actual state after above items

4. ~~**MSS clamping**~~ ✅ — add TCPMSS rules in wg_cascade firewall tasks
   - `firewall_keep.yml` — `blockinfile` injects `*mangle … --clamp-mss-to-pmtu … COMMIT` before `*filter`
   - `firewall_disable.yml` — `ansible.builtin.iptables` task on `mangle` table with `clamp_mss_to_pmtu: true`

5. ~~**External reachability verify**~~ ✅ — controller-side `wait_for` checks in `verify_all.yml`
   - New play "External Reachability (Controller → Servers)" runs on `localhost`
   - TCP connect: controller → Server A:`port_a_tcp`, controller → Server B:`port_b_tcp`
   - `assert` with `ignore_errors: true` (warning-only, playbook continues to summary)
   - Final `debug` shows OK/FAIL per endpoint
   - UDP WireGuard ports excluded (stateless, requires live WG client)
   - Tags: `verify`, `reachability` — run subset with `--tags reachability`

6. ~~**DPI evasion defaults**~~ ✅ — baked better defaults into roles and inventory
   - `port_a_tcp`: `8443` → `443` (all.yml, relay/defaults, relay_servers.yml.example)
   - `xray_reality_dest` / `xray_reality_server_names`: `www.cloudflare.com` → `www.microsoft.com`
   - `xray_vless_flow`: `""` → `"xtls-rprx-vision"` (xray_server/defaults, xray_servers.yml.example)
   - Removed "DPI Evasion Notes" section from CLAUDE.md (guidance now lives in the defaults)

7. **Unify client/user terminology** — в проекте WireGuard-сущности называются "client" (`add_client.yml`), а XRay — "user" (`add_xray_user.yml`). Выбрать единый термин (client или user) и применить ко всем playbooks, ролям, переменным и документации
   - Переименовать плейбуки: либо `add_client.yml` + `add_xray_client.yml`, либо `add_user.yml` + `add_xray_user.yml`
   - Привести в соответствие переменные, шаблоны, команды бота (`/add_client`, `/clients` vs `/add_xray`, `/users`)
   - Check: единый термин используется во всех файлах?

## Future: Control-Plane (Telegram Bot)

Спроектирован, не реализован. Подробности в DESIGN.md, секция "Control-Plane".

- [ ] Server C setup — отдельный сервер с repo clone, SSH ключами к A/B
- [ ] `bot/` scaffold — TypeScript + grammY + systemd unit
- [ ] Команды: `/add_client`, `/add_xray`, `/status`, `/update`, `/reboot`, `/clients`, `/users`, `/deploy` *(имена команд зависят от решения по п.8 — унификация терминологии client/user)*
- [ ] SQLite аудит-лог
- [ ] Ansible JSON callback parsing
