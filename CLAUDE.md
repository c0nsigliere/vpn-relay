# VPN Relay — Project Context

Ansible-managed VPN stack across two Ubuntu servers. Always read this before
modifying any role, playbook, or variable.

## Architecture

Two servers, three parallel subsystems:

```
Server A (Russia, entry point)          Server B (abroad, exit point)
─────────────────────────────           ─────────────────────────────
WG cascade:  wg-clients :51888/udp      XRay only — no WireGuard on B
             10.66.0.0/24
             iptables TPROXY :12345  ──► XRay VLESS+Reality :8443
             ip rule fwmark 0x1          freedom outbound → Internet
             → table 100 → lo           (original dst preserved)

TCP relay:   :443/tcp ─────────────────► :443/tcp (DNAT+MASQUERADE)
             pure L4, zero secrets       XRay VLESS+Reality (systemd)
                                         Reality keys in /etc/xray/keys/
                                         Clients in /etc/xray/clients.json
```

**Critical invariants:**
- Server A never holds XRay keys or Reality secrets
- Reality private key never leaves Server B
- Server B has NO WireGuard — only XRay. wg-uplink is gone from both servers.
- TPROXY (fwmark 0x1 → table 100) isolates client traffic from SSH/default route on A
- TCP relay is pure L4 byte forwarding — no protocol awareness, no decryption
- `xray_tproxy_port` (default 12345) must match between wg_cascade role and relay role

## Inventory Groups → Roles → Playbooks

| Group | Hosts | Role | Playbook |
|-------|-------|------|----------|
| `wg_cascade` | A only | `wg_cascade` | `wg_cascade.yml` |
| `relay_servers` | A | `relay` | `relay.yml` |
| `xray_servers` | B | `xray_server` | `xray.yml` |
| (all) | A + B | `maintenance` | `maintenance.yml` |

## All Playbooks

Run order for full stack deploy: `bootstrap_ssh.yml` first, then `stack.yml` (chains the rest).

`stack.yml` supports `--skip-tags maintenance,update,upgrade,reboot,health` for partial runs.

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

**Terminology:** Always use `client` (not `user`): `client_name`, `client_uuid`, `clients.json`, `_xray_clients`.

**DPI evasion defaults** (in role `defaults/main.yml` — wrong values break clients):
- `xray_port: 8443` — XRay listens on B (not 443)
- `port_a_tcp: 443` / `port_b_tcp: 8443` — relay A→B forwarding
- `xray_reality_dest: "www.googletagmanager.com:443"` — camouflage domain
- `xray_vless_flow: "xtls-rprx-vision"`, `xray_reality_fingerprint: "chrome"`

**MSS clamping** — required for MTU stability across tunnel boundaries:
`firewall_keep.yml` uses `*mangle` table with `--clamp-mss-to-pmtu`;
`firewall_disable.yml` uses `clamp_mss_to_pmtu: true` parameter.

**Tag dual-pattern:** Verify tasks carry two tags: `tags: [verify, cascade]` — hit by
`--tags verify` (all checks) or `--tags cascade` (subsystem-specific).

**Health sentinel:** `/etc/sysctl.d/99-vpn-relay.conf` marks a host as deployed.
Fresh hosts skip hard-fail assertions; deployed hosts fail on firewall/routing drift.

**Rollback safety gates:** `wg_cascade_remove_keys: false` and `xray_remove_keys: false`
prevent accidental key deletion — must explicitly set to `true` to wipe keys.

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

## Artifacts

Client provisioning playbooks write locally to `artifacts/` (relative to repo root):

## Other tasks

You can connect to servers directly via SSH (the keys are already registered) to conduct diagnostics. You can install tools on the local computer and remote servers.

## After Each Change

After completing any modification, verify that the following docs reflect the
current state of the codebase:

- **`DESIGN.md`** — architecture, target state, subsystem diagrams
- **`README.md`** — setup instructions, usage examples, public-facing info
- **`TODO.md`** — completed items marked done, new debt items added

If a change makes any of these files stale, update them as part of the same
task before finishing.

