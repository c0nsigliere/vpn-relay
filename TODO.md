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

7. ~~**Unify client/user terminology**~~ ✅ — unified on "client" across all playbooks, roles, variables, and docs
   - Playbooks renamed: `add_client.yml` → `add_wg_client.yml`, `add_xray_user.yml` → `add_xray_client.yml`, `cascade.yml` → `wg_cascade.yml`, etc.
   - XRay extra vars: `user_name`/`user_uuid` → `client_name`/`client_uuid`
   - XRay data file: `users.json` → `clients.json` (with one-time migration task)
   - Internal facts: `_xray_users` → `_xray_clients`, `_user_uuid` → `_client_uuid`, etc.
   - XRay JSON protocol keys (`"clients"`, `"users"`) left unchanged (spec-dictated)

- [x] **Remove wg-uplink, replace with XRay TPROXY** ✅ — wg-uplink eliminated from both servers
  - Server B removed from `[wg_cascade]` group — no WireGuard on B at all
  - `roles/wg_cascade`: removed wg-uplink keypair generation/exchange, configs, routing (table 200),
    services, firewall NAT/FORWARD rules for B; added TPROXY mangle chain (XRAY_WG_TPROXY)
  - `roles/wg_cascade/templates/wg-clients.conf.j2`: PostUp/PreDown for TPROXY routing
    (ip rule fwmark 0x1 → table 100, ip route local 0.0.0.0/0 dev lo)
  - `roles/wg_cascade/tasks/sysctl.yml`: rp_filter changed from 2 (loose) to 0 (disabled)
    — required for TPROXY; per-interface rp_filter set via wg-clients PostUp
  - `roles/relay/templates/xray-uplink-client.json.j2`: replaced dokodemo-door UDP approach
    with TPROXY inbound (dokodemo-door + followRedirect) + mux enabled outbound
  - `roles/relay/defaults/main.yml`: removed `wg_uplink_port_b`/`xray_wg_uplink_port`,
    added `xray_tproxy_port: 12345`
  - Deleted: `wg-uplink-a.conf.j2`, `wg-uplink-b.conf.j2`
  - Rollback playbook fully rewritten for TPROXY teardown

## Priorities (continued)

- [x] **`health.yml` false-fails on fresh servers** ✅ — all CRITICAL assertions and iptables
  display tasks now gated on `/etc/sysctl.d/99-vpn-relay.conf` existing (deployment state
  probe). Fresh servers skip ip_forward / UFW / rules.v4 / iptables checks with a warning;
  regressions on configured servers still hard-fail as intended. Duplicate sysctl stat block
  removed. iptables tasks also carry `failed_when: false` as belt-and-suspenders against
  missing binary on fresh Ubuntu 22+ hosts.

- [x] **Strip service verification from maintenance.yml** ✅ — removed `post_tasks` blocks that
  duplicated `relay/tasks/verify.yml` and `wg_cascade/tasks/verify.yml`; removed iptables counter
  and listening-port display tasks from `health.yml` (covered by dedicated verify playbooks);
  kept hard-fail assertions (`ip_forward`, UFW active, `rules.v4`) which are unique post-maintenance checks.

- [ ] **Remove plaintext `ansible_password` from `inventory/inventory.ini`** — run `bootstrap_ssh.yml`
  to push SSH keys to both servers, verify key login works, run `--tags harden` to disable
  password auth, then delete the `ansible_password=` lines from inventory.

## Telegram Bot Control Plane

- [x] **Phase 0A** — XRay gRPC API enabled in `config.json.j2`: `stats`, `policy`, `api`, dokodemo-door inbound on `127.0.0.1:10085`, routing rule api→api. `xray_api_port: 10085` in `xray_server/defaults/main.yml`.
- [x] **Phase 1** — Bot scaffold: `bot/package.json`, `tsconfig.json`, `src/config/env.ts` (Zod), `src/db/index.ts` (WAL SQLite), `src/db/queries.ts`, `src/bot/context.ts`, auth middleware, `src/index.ts`
- [x] **Phase 2** — XRay gRPC service: `src/services/xray.service.ts` — addClient (gRPC AlterInbound + atomic clients.json sync), removeClient, getStats, queryAllStats, generateVlessUris
- [x] **Phase 3** — WireGuard SSH service: `src/services/ssh.ts` (auto-reconnecting ssh2 pool), `src/services/wg.service.ts` — addClient (keygen on A, mutex IP allocation, syncconf), removeClient, suspendClient, resumeClient, getStats
- [x] **Phase 4** — Telegram UI: main/add-client/client-list/client-card/server-status/settings menus; text-input handler with session state; full callback router in `index.ts`
- [x] **Phase 5** — Workers: traffic (10min), TTL (1h), health (1min, 3-failure threshold), updates (12h)
- [x] **Phase 6** — Support services: charts (chartjs-node-canvas), QR (qrcode), system (local /proc + SSH remote)
- [x] **Phase 0B/0C** — Ansible role `telegram_bot` (validate/install/deploy/service/verify), `playbooks/deploy_bot.yml`, `stack.yml` updated to step 7
- [x] **Bot rollback** — `playbooks/remove_bot.yml`: stops service, removes unit, revokes ACLs, revokes SSH key from Server A, removes app dir, optionally removes data dir (SQLite DB), removes system user/group. Safety gate: `-e "bot_remove=true"`, data preserved by default unless `-e "bot_remove_data=true"`

## Debt / Future

- [ ] **Remove plaintext `ansible_password` from inventory** — run `bootstrap_ssh.yml` to push SSH keys, verify key login, run `--tags harden`, then remove `ansible_password=` lines
- [ ] **Bot: Ansible vault for credentials** — move `bot_telegram_token`/`bot_admin_id` to `inventory/host_vars/server-b/vault.yml` encrypted with `ansible-vault`
- [ ] **Bot: client expiry UI** — add expiry date input in add-client flow (currently always null, TTL worker ready)
- [ ] **Bot: WG config re-send** — private key is only available at creation; consider storing encrypted or re-generating on demand
