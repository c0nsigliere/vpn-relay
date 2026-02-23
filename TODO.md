# TODO

## Completed

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

1. **Unify IP variable** — remove `ip_b_public`, keep `server_b_public_ip`
   - Check: `inventory/group_vars/all.yml` still has `ip_b_public`?

2. **Memory checks in verify_all.yml** — add memory/swap warnings
   - Reuse logic from `roles/wg_cascade/tasks/memory.yml`
   - Check: `playbooks/verify_all.yml` includes memory/swap checks?

3. **Create stack.yml** — single entrypoint: maintenance → swap → cascade → xray → relay → verify
   - Check: `playbooks/stack.yml` exists?

4. **Update DESIGN.md** — sync with actual state after above items

5. **MSS clamping** — add TCPMSS rules in wg_cascade firewall tasks
   - Add `iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu` in `firewall_keep.yml` and `firewall_disable.yml`
   - Check: `roles/wg_cascade/tasks/firewall_keep.yml` has TCPMSS rules?

6. **External reachability verify** — controller-side `wait_for`/`uri` checks
   - Add tasks in verify playbooks that test connectivity from Ansible controller
   - Check: verify playbooks have `delegate_to: localhost` checks?

7. **DPI evasion defaults** — evaluate relay port 443, geo-neutral SNI, `xtls-rprx-vision` flow
   - See CLAUDE.md "DPI Evasion Notes" for details

## Future: Control-Plane (Telegram Bot)

Спроектирован, не реализован. Подробности в DESIGN.md, секция "Control-Plane".

- [ ] Server C setup — отдельный сервер с repo clone, SSH ключами к A/B
- [ ] `bot/` scaffold — TypeScript + grammY + systemd unit
- [ ] Команды: `/add_client`, `/add_xray`, `/status`, `/update`, `/reboot`, `/clients`, `/users`, `/deploy`
- [ ] SQLite аудит-лог
- [ ] Ansible JSON callback parsing
