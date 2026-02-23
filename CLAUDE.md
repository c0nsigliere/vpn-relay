# VPN Relay — Project Context

Ansible-managed VPN stack across two Ubuntu servers. Always read this before
modifying any role, playbook, or variable.

## Architecture

Two servers, three parallel subsystems:

```
Server A (Russia, entry point)          Server B (abroad, exit point)
─────────────────────────────           ─────────────────────────────
WG cascade:  wg-clients :51888/udp  ──► wg-uplink :51821/udp ──► Internet
             10.66.0.0/24               10.200.0.0/30
             policy routing table 200   MASQUERADE → WAN

TCP relay:   :443/tcp ─────────────────► :443/tcp (DNAT+MASQUERADE)
             pure L4, zero secrets       XRay VLESS+Reality (systemd)
                                         Reality keys in /etc/xray/keys/
                                         Users in /etc/xray/users.json
```

**Critical invariants:**
- Server A never holds XRay keys or Reality secrets
- Reality private key never leaves Server B
- Table 200 isolates client traffic from SSH/default route on A — breaking this means losing SSH
- TCP relay is pure L4 byte forwarding — no protocol awareness, no decryption
- No Docker, no Amnezia anywhere in the stack

## Inventory Groups → Roles → Playbooks

| Group | Hosts | Role | Playbook |
|-------|-------|------|----------|
| `wg_cascade` | A + B | `wg_cascade` | `cascade.yml` |
| `relay_servers` | A | `relay` | `relay.yml` |
| `xray_servers` | B | `xray_server` | `xray.yml` |
| (all) | A + B | `maintenance` | `maintenance.yml` |

## Code Conventions

Follow these patterns in every change:

**Role task pipeline:** `validate.yml` → domain tasks → `verify.yml`.
Validate inputs before touching the system, verify state after.

**Firewall modes** (`manage_ufw` variable):
- `"keep"` — UFW enabled, NAT rules in `/etc/ufw/before.rules`, tasks in `firewall_keep.yml`
- `"disable"` — UFW off, `iptables-persistent`, tasks in `firewall_disable.yml`
- Never mix both on the same host.

**WAN interface:** `wan_if` variable (empty = auto-detect). Resolved to
`wan_if_final` fact in `validate.yml`. Use `wan_if_final` in all subsequent tasks.

**Tags** mirror task file names: `validate`, `keys`, `configs`, `firewall`,
`verify`, etc. Users run subsets with `--tags`.

**Security:**
- `no_log: true` on any task exposing private keys
- Config files: 0600. Key directories: 0700.

**Memory parsing:** `roles/wg_cascade/tasks/memory.yml` sets facts:
`_mem_available_mb`, `_swap_total_mb`, `_swap_free_mb`, `_mem_total_mb`.
Reusable from any playbook via `include_tasks`.

## Variable Hierarchy

```
roles/*/defaults/main.yml    ← role defaults (lowest priority)
inventory/group_vars/all.yml ← shared: server_b_public_ip, manage_ufw, ports, WG addressing
inventory/group_vars/*.yml   ← per-group overrides (wg_cascade, relay_servers, xray_servers)
inventory/host_vars/*.yml    ← per-host overrides (rarely used)
-e "var=value"               ← CLI overrides (highest priority)
```

Canonical IP variable: `server_b_public_ip`. If you see `ip_b_public` — that's
a legacy duplicate, use `server_b_public_ip`.

## Known Technical Debt

See `TODO.md` for the full list. Target architecture is in `DESIGN.md`. Key themes:
- ~~Legacy Amnezia/Docker references in code and docs~~ (done)
- `ip_b_public` duplicates `server_b_public_ip`
- `cleanup_legacy_relay.yml` should be deleted
- ~~`verify_all.yml` missing memory/swap checks~~ (done)
- ~~No `stack.yml` single entrypoint yet~~ (done — `playbooks/stack.yml`)

## After Each Change

After completing any modification, verify that the following docs reflect the
current state of the codebase:

- **`DESIGN.md`** — architecture, target state, subsystem diagrams
- **`README.md`** — setup instructions, usage examples, public-facing info
- **`TODO.md`** — completed items marked done, new debt items added

If a change makes any of these files stale, update them as part of the same
task before finishing.

