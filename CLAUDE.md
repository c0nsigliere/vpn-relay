# VPN Relay — Project Context

Ansible-managed VPN stack across two Ubuntu servers (server A in Russia and server B abroad) with control plane implemented as telegram bot (with telegram mini app) on server B.

## Server Roles:

- Server A (Entry / Russia): Acts as the ingress node. Runs WireGuard and a pure L4 TCP port forwarder. It contains NO XRay cryptographic secrets or client configs.
- Server B (Exit / Abroad): Acts as the egress node. Runs XRay (VLESS+Reality) and handles all actual decryption and internet routing. It contains NO WireGuard installation. Stores XRay keys (`/etc/xray/keys/`). Client state lives in the bot's SQLite DB (`/var/lib/vpn-bot/data.db`); `config.json` is rebuilt from DB on every change.

## The 3 Ways Clients Can Connect:

- WireGuard Cascade (WG ➔ A ➔ B): Client connects to Server A via WireGuard (UDP). Server A intercepts this traffic via TPROXY and tunnels it to Server B's XRay.
- XRay Relay (VLESS ➔ A ➔ B): Client connects to Server A via VLESS (TCP). Server A blindly forwards the traffic via DNAT to Server B's XRay. Server A acts as a dumb pipe.
- Direct XRay (VLESS ➔ B): Client bypasses Server A entirely and connects directly to Server B's XRay (TCP).

**Critical invariants:**
- Strict Secret Isolation: Server A is a "dumb pipe". It NEVER holds XRay configurations, Reality private keys, or client UUIDs. All decryption happens on Server B.
- Routing Logic: Server A routes WireGuard traffic via TPROXY, and VLESS traffic via pure L4 TCP forwarding (no protocol awareness).
- Single Source of Truth: ALL port numbers and shared configuration variables must be defined strictly in `group_vars/all.yml`. Do NOT put port definitions in role `defaults/main.yml`.

## Project Scope & Holistic Consistency:
This is a tightly coupled, multi-tier architecture (GrammY Bot + Fastify API + React TMA + Ansible Infrastructure). Every code change must be evaluated for cross-stack impact. If a new bot feature or API endpoint requires a new OS package, a new open port, a database schema change, or specific file permissions, you MUST ensure those requirements are reflected in the codebase and infrastructure.

## Infrastructure as Code (IaC) Workflow:
Ansible playbooks in this project serve strictly as the "Reference Architecture" for a fresh, from-scratch installation.

- Declarative Code (Ansible): Update Ansible roles (group_vars, templates, tasks) to reflect the final, pristine target state. Do NOT write transitional Ansible tasks designed solely to migrate or patch the current live server state.
- Imperative Execution (Live Servers): When a codebase change requires updating an existing live environment (e.g., altering a database schema, moving a file, or restarting a service), you must use your execution tools (direct SSH, commands) to apply these hotfixes and state migrations yourself. Bring the live server into alignment with the new code immediately, without cluttering the reference playbooks.

## Execution Transparency & Mentorship:
When utilizing tools to perform complex actions (e.g., executing SSH commands, running database migrations, or modifying live server state), you must act as a senior mentor and make your thought process transparent.

- Architectural & Technological Decisions: When proposing software code, API structures, or database schemas, explain the why. Why choose this specific algorithmic approach, design pattern, or library. Briefly outline the trade-offs (e.g., performance vs. readability, memory footprint vs. speed) and why your solution fits this specific project best.
- Explain the "Why": Before executing a structural change or complex command, briefly explain the rationale behind your approach and why it is the safest or most optimal method.
- Deconstruct the Syntax: If you deploy intricate Linux commands (e.g., sed, awk, grep pipes, iptables), advanced SQL queries, or complex framework patterns, break down what the syntax actually does so I can learn from it.
- Transparent Troubleshooting: If an execution fails and you need to pivot, do not just silently try another command. Briefly explain your hypothesis for why it failed and how your next step addresses the error.

## Collaborative Design & Proactive Clarification:
Act as a Co-Architect. Your goal is to help me build the right solution, not just the fastest one.

- Do Not Blindly Execute: If my request is vague, incomplete, or potentially flawed from an engineering standpoint, DO NOT just guess and write code. Stop and push back.
- Ask Probing Questions: Actively ask clarifying questions to help me shape the final design. Point out edge cases I might have missed (e.g., "What happens if the XRay server is unreachable?", "Should we paginate this API response?").
- Propose Options: When asking for clarification, try to offer 2-3 viable architectural options with their respective trade-offs (complexity vs. performance) so I can make an informed decision. I value your pushback more than immediate compliance.

## Active Diagnostics & Server Access:
You are authorized and explicitly encouraged to act autonomously to diagnose issues. You have direct SSH access to both servers (keys are pre-configured). Connect via ssh root@server-a or ssh root@server-b (or via IP).

- Do Not Guess, Verify: If a system is broken, do not hallucinate solutions. SSH into the servers, read logs (journalctl), check service statuses (systemctl), test connectivity, or run trace commands.
- Tool Installation & Cleanup (Leave No Trace): You may install diagnostic packages (e.g., tcpdump, jq, net-tools) locally or remotely to aid your investigation. However, you must act as a clean professional: once the issue is resolved, immediately remove any temporary scripts, test files, or one-off diagnostic tools you installed.
- Human-in-the-loop for Ansible: DO NOT execute ansible-playbook commands yourself, especially full stack deployments. Instead, formulate the exact CLI command (including any specific --tags, -l, or -e flags) and ask me to run it in my terminal. I must retain full visual control over Ansible's execution logs and state changes.

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

**Terminology:** Always use `client` (not `user`): `client_name`, `client_uuid`.

**DPI evasion defaults** (in `group_vars/all.yml` — wrong values break clients):
- `xray_port: 443` — XRay listens on B
- `port_a_tcp: 443` / `port_b_tcp: 443` — relay A→B forwarding
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

## After Each Change

After completing any modification, verify that the following docs reflect the
current state of the codebase:

- **`DESIGN.md`** — architecture, target state, subsystem diagrams
- **`README.md`** — setup instructions, usage examples, public-facing info

If a change makes any of these files stale, update them as part of the same
task before finishing.

