# Server Maintenance and Updates

## Why Maintenance is Separate from the Roles

The `roles/relay/` and `roles/wg_cascade/` roles are deployment roles — they configure services and are designed to be idempotent and auditable. Embedding OS update logic inside them would violate the single-responsibility principle and make it harder to run updates independently without risk of accidentally reconfiguring services.

Maintenance is a distinct operational concern handled by `roles/maintenance/` and the playbooks in `playbooks/`. The deployment roles are never modified during maintenance, which means the service configuration remains stable and predictable.

## Maintenance Targets

All maintenance playbooks target `wg_cascade:relay_servers` (Ansible union pattern), which covers:
- **Both features active:** Server A + Server B from wg_cascade, Server A from relay_servers (deduplicated)
- **Cascade only:** Server A + Server B from wg_cascade
- **Relay only:** Server A from relay_servers

## Update vs. Upgrade: Know the Difference

| Playbook | Apt Command | Removes packages? | When to use |
|----------|-------------|-------------------|-------------|
| `playbooks/update.yml` | `apt upgrade` | Never | Regular security patching (weekly/monthly) |
| `playbooks/upgrade.yml` | `apt dist-upgrade` | Sometimes | Scheduled maintenance windows only |

- **Safe upgrade** (`apt upgrade`): Upgrades packages only if it can do so without removing any installed package. Handles 95% of patch scenarios. Safe to run at any time without a window.
- **Dist-upgrade** (`apt dist-upgrade`): Resolves complex dependency changes, may remove packages. Required after major kernel updates or when held packages need to update. Always review the removed-packages list before proceeding.

## When to Use Each Playbook

| Playbook | Purpose | Reboots? |
|----------|---------|---------|
| `playbooks/update.yml` | Safe package update only | No |
| `playbooks/upgrade.yml` | dist-upgrade (maintenance window) | No |
| `playbooks/reboot-if-needed.yml` | Reboot only if required | If needed |
| `playbooks/maintenance.yml` | Full workflow: update + reboot + verify | If needed |

Use `playbooks/maintenance.yml` as the default entry point for all routine maintenance. It handles the complete flow including service verification after updates.

## Reboot Strategy

Ubuntu writes `/var/run/reboot-required` after installing packages that require a reboot (kernel, glibc, openssl). The maintenance subsystem checks this sentinel file — no file means no reboot.

**`maintenance_reboot: true` (default):** Reboots immediately after updates if required. Suitable for scheduled maintenance windows. Required for kernel updates to take effect.

**Deferring reboots:** Set `maintenance_reboot: false` to skip the reboot step. Run `playbooks/reboot-if-needed.yml` at a later time (e.g., off-peak hours) to apply the deferred reboot.

```bash
# Update now, reboot later
ansible-playbook playbooks/maintenance.yml -e "maintenance_reboot=false"

# Reboot when ready
ansible-playbook playbooks/reboot-if-needed.yml
```

After any reboot, `maintenance.yml` automatically runs service verification to confirm both cascade and relay survived intact.

## Firewall Persistence After Upgrades

**UFW keep mode** (`manage_ufw: keep`):
UFW stores rules in `/etc/ufw/before.rules` — a config file that persists across reboots and kernel upgrades. After reboot, UFW starts automatically via systemd and reloads all rules. No manual intervention needed. After a `ufw` package upgrade, run `--tags verify` to confirm NAT rules in `before.rules` are still intact.

**iptables disable mode** (`manage_ufw: disable`):
Rules are persisted in `/etc/iptables/rules.v4` by `netfilter-persistent`. This is a systemd service that loads saved rules at boot. A kernel upgrade does not wipe this file. After reboot, rules are restored automatically by `netfilter-persistent.service`. If the service fails to start after a kernel upgrade, the health checks will catch it.

## UFW vs. iptables Mode Implications for Maintenance

**After a `ufw` package upgrade (keep mode):**
- Verify NAT rules are still in `/etc/ufw/before.rules`: the blockinfile markers should be present
- Run `ansible-playbook playbooks/verify_all.yml` to confirm
- If rules are missing, re-apply: `ansible-playbook playbooks/relay.yml --tags ufw`

**After an `iptables-persistent` or `netfilter-persistent` upgrade (disable mode):**
- Verify `/etc/iptables/rules.v4` still exists and contains the correct rules
- Verify `netfilter-persistent` service is running: `systemctl status netfilter-persistent`
- If rules are missing: `ansible-playbook playbooks/relay.yml --tags iptables,persist`

**After any kernel upgrade:**
- New kernel may include updated netfilter modules. Test traffic after reboot.
- Check iptables counters: non-zero pkts/bytes means traffic is flowing.
- Health checks in `maintenance.yml` verify this automatically.

## Recommended Maintenance Workflow

**Standard monthly maintenance (routine security patches):**

```bash
# Step 1: Run full maintenance workflow
ansible-playbook playbooks/maintenance.yml

# Step 2: Review output for:
#   - ip_forward = 1 (confirmed by health check)
#   - UFW active or rules.v4 present
#   - PREROUTING/FORWARD rules present
#   - Service verification passed (cascade + relay)

# Step 3: Test VPN connectivity from a client (manual)
```

**Scheduled maintenance window (kernel or major updates):**

```bash
# Step 1: Notify users of downtime
# Step 2: Run with dist-upgrade enabled
ansible-playbook playbooks/maintenance.yml -e "do_dist_upgrade=true"

# Step 3: Review removed packages in output
# Step 4: Confirm health check output (ip_forward, firewall, counters)
# Step 5: Test VPN client connectivity (manual)
```

**Deferred reboot workflow:**

```bash
# Apply updates during business hours (no reboot)
ansible-playbook playbooks/maintenance.yml -e "maintenance_reboot=false"

# Reboot during off-peak hours
ansible-playbook playbooks/reboot-if-needed.yml

# Verify all services after reboot
ansible-playbook playbooks/verify_all.yml
```

## Example Commands

```bash
# Safe update (run anytime)
ansible-playbook playbooks/update.yml

# Full maintenance with automatic reboot if needed (recommended default)
ansible-playbook playbooks/maintenance.yml

# Full maintenance + dist-upgrade (maintenance window required)
ansible-playbook playbooks/maintenance.yml -e "do_dist_upgrade=true"

# Full maintenance without rebooting (defer reboot)
ansible-playbook playbooks/maintenance.yml -e "maintenance_reboot=false"

# Reboot now if /var/run/reboot-required exists
ansible-playbook playbooks/reboot-if-needed.yml

# Health checks only (no updates)
ansible-playbook playbooks/maintenance.yml --tags health

# Update + health checks (no reboot)
ansible-playbook playbooks/maintenance.yml -e "maintenance_reboot=false" --tags update,health

# Disable unattended-upgrades
ansible-playbook playbooks/maintenance.yml \
  -e "manage_unattended_upgrades=false" --tags unattended

# With password authentication
ansible-playbook playbooks/maintenance.yml --ask-pass
```

## Post-Update Verification Checklist

After any maintenance run, confirm the following in the output:

**Critical (must pass):**
- [ ] `net.ipv4.ip_forward = 1` — shown in health check
- [ ] UFW status active (keep mode) OR `/etc/iptables/rules.v4` exists (disable mode)
- [ ] PREROUTING has DNAT rules for entry ports
- [ ] FORWARD chain has ACCEPT rules for Server B

**Important (review warnings):**
- [ ] `rp_filter = 2` for `conf.all` and `conf.default` — asymmetric routing requires loose mode
- [ ] `/etc/sysctl.d/99-vpn-relay.conf` exists — ensures sysctl survives reboot
- [ ] No unexpected packages removed (review dist-upgrade output if applicable)

**After reboot only:**
- [ ] `netfilter-persistent` service running (disable mode): `systemctl status netfilter-persistent`
- [ ] UFW service running (keep mode): `systemctl status ufw`
- [ ] Test VPN client can connect and route traffic

## Risks of Unattended-Upgrades on VPN Nodes

The `unattended-upgrades` package provides automatic background security updates. While valuable for general servers, it carries specific risks for VPN nodes:

**Automatic reboot risk:** If `Unattended-Upgrade::Automatic-Reboot "true"` is set, the server may reboot in the background after a kernel update. All active VPN tunnels will drop without warning.

**Rule restoration window:** Even with correct persistence, there is a brief period after reboot during which the server is not forwarding traffic (while systemd starts UFW or netfilter-persistent). For latency-sensitive applications, this is unavoidable.

**Recommendation for VPN nodes:**
- Set `manage_unattended_upgrades: "false"` to disable automatic updates
- Schedule manual maintenance using `playbooks/maintenance.yml` on a regular cadence (weekly or monthly)
- This provides the same security coverage with controlled timing

**If unattended-upgrades must remain enabled** (compliance requirement):
- At minimum, disable automatic reboots by creating `/etc/apt/apt.conf.d/99relay-unattended`:
  ```
  Unattended-Upgrade::Automatic-Reboot "false";
  ```
- This prevents surprise reboots while still allowing background package updates
- Schedule reboots explicitly via `ansible-playbook playbooks/reboot-if-needed.yml`

**Security trade-off:** Disabling unattended-upgrades means you are responsible for timely patch application. Use `playbooks/update.yml` at minimum on a weekly schedule for security patches, and immediately when critical CVEs are published (kernel, openssl, glibc).
