# VPN Relay - Ansible Transparent L4 Forward

Production-ready Ansible repository for configuring a transparent Layer 4 relay on Ubuntu 22.04/24.04.

## Architecture

```
┌──────────┐         ┌──────────────────┐         ┌──────────────────┐
│  Client  │ ──────> │   Server A       │ ──────> │   Server B       │
│          │         │   (Relay)        │         │   (VPN Endpoint) │
│ B's keys │         │ No keys/decrypt  │         │ VPN server       │
│ A's IP   │         │ Pure forwarding  │         │                  │
└──────────┘         └──────────────────┘         └──────────────────┘
     :51821               DNAT+MASQ                    :51820
```

**Key Points:**
- Server A acts as a transparent relay only (no decryption, no keys)
- Server B is the actual VPN endpoint
- Client connects to A using B's credentials
- All traffic is forwarded at L4 (TCP/UDP)

## Firewall Mode Comparison

| Aspect | `manage_ufw: "keep"` | `manage_ufw: "disable"` |
|--------|---------------------|------------------------|
| Firewall | UFW enabled | UFW disabled |
| Rule storage | `/etc/ufw/before.rules` | `iptables-persistent` |
| Rule management | blockinfile + ufw module | ansible.builtin.iptables |
| Persistence | Automatic via UFW | netfilter-persistent save |
| Best for | Existing UFW setups | Clean iptables setups |

**Important:** Never mix both mechanisms. Choose one mode and stick with it.

## Quick Start

### 1. Configure Inventory

Edit `inventory/inventory.ini`:

```ini
[relay_servers]
relay1 ansible_host=YOUR_SERVER_A_IP

[relay_servers:vars]
ansible_user=root
# Option 1: Store password in inventory (less secure)
# ansible_password=your_root_password

# Option 2: Use --ask-pass flag when running playbook (recommended)
```

### 2. Run the Playbook

```bash
# With password prompt (recommended for root/password auth)
ansible-playbook playbooks/relay.yml -e "ip_b=10.0.0.2" --ask-pass

# With SSH key (no password prompt needed)
ansible-playbook playbooks/relay.yml -e "ip_b=10.0.0.2"

# Full configuration
ansible-playbook playbooks/relay.yml \
  -e "ip_b=10.0.0.2" \
  -e "port_a_udp=51821" \
  -e "port_a_tcp=8443" \
  -e "port_b_udp=51820" \
  -e "port_b_tcp=443" \
  -e "manage_ufw=keep" \
  --ask-pass
```

### 3. Verify

```bash
ansible-playbook playbooks/relay.yml -e "ip_b=10.0.0.2" --tags verify
```

## Variable Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `ip_b` | **required** | Target VPN server (Server B) IP address |
| `port_a_udp` | `51821` | UDP entry port on relay (Server A) |
| `port_a_tcp` | `8443` | TCP entry port on relay (Server A) |
| `port_b_udp` | `51820` | UDP target port on VPN server (Server B) |
| `port_b_tcp` | `443` | TCP target port on VPN server (Server B) |
| `wan_if` | auto-detect | WAN interface (leave empty for auto-detection) |
| `manage_ufw` | `keep` | Firewall mode: `keep` or `disable` |

## Client Configuration

Configure your VPN client with:
- **Server IP/Endpoint:** Server A's public IP
- **Port:** Entry port on A (`port_a_udp` for WireGuard/AWG, `port_a_tcp` for XRay)
- **Keys/Credentials:** Server B's keys (the relay doesn't need them)

Example WireGuard client config:
```ini
[Peer]
PublicKey = <SERVER_B_PUBLIC_KEY>
Endpoint = <SERVER_A_IP>:51821  # A's IP, A's entry port
AllowedIPs = 0.0.0.0/0
```

## Tags

Run specific parts of the playbook:

```bash
# Only validation
ansible-playbook playbooks/relay.yml -e "ip_b=10.0.0.2" --tags validate

# Only sysctl configuration
ansible-playbook playbooks/relay.yml -e "ip_b=10.0.0.2" --tags sysctl

# Only UFW/firewall configuration
ansible-playbook playbooks/relay.yml -e "ip_b=10.0.0.2" --tags ufw

# Only iptables rules (disable mode)
ansible-playbook playbooks/relay.yml -e "ip_b=10.0.0.2" --tags iptables

# Only verification
ansible-playbook playbooks/relay.yml -e "ip_b=10.0.0.2" --tags verify
```

## Rollback

Remove all relay configuration:

```bash
# If using keep mode (default)
ansible-playbook playbooks/rollback.yml -e "manage_ufw=keep"

# If using disable mode, specify ip_b for rule removal
ansible-playbook playbooks/rollback.yml \
  -e "manage_ufw=disable" \
  -e "ip_b=10.0.0.2"
```

## Server Maintenance and Updates

### Why Maintenance is Separate from the Relay Role

The `roles/relay/` role is a deployment role — it configures a clean relay and is designed to be idempotent and auditable. Embedding OS update logic inside it would violate the single-responsibility principle and make it harder to run updates independently without risk of accidentally reconfiguring the relay.

Maintenance is a distinct operational concern handled by `roles/maintenance/` and the playbooks in `playbooks/`. The relay role is never modified, which means the relay configuration remains stable and predictable.

### Update vs. Upgrade: Know the Difference

| Playbook | Apt Command | Removes packages? | When to use |
|----------|-------------|-------------------|-------------|
| `playbooks/update.yml` | `apt upgrade` | Never | Regular security patching (weekly/monthly) |
| `playbooks/upgrade.yml` | `apt dist-upgrade` | Sometimes | Scheduled maintenance windows only |

- **Safe upgrade** (`apt upgrade`): Upgrades packages only if it can do so without removing any installed package. Handles 95% of patch scenarios. Safe to run at any time without a window.
- **Dist-upgrade** (`apt dist-upgrade`): Resolves complex dependency changes, may remove packages. Required after major kernel updates or when held packages need to update. Always review the removed-packages list before proceeding.

### When to Use Each Playbook

| Playbook | Purpose | Reboots? |
|----------|---------|---------|
| `playbooks/update.yml` | Safe package update only | No |
| `playbooks/upgrade.yml` | dist-upgrade (maintenance window) | No |
| `playbooks/reboot-if-needed.yml` | Reboot only if required | If needed |
| `playbooks/maintenance.yml` | Full workflow: update → reboot → verify | If needed |

Use `playbooks/maintenance.yml` as the default entry point for all routine maintenance. It handles the complete flow including relay verification after updates.

### Reboot Strategy

Ubuntu writes `/var/run/reboot-required` after installing packages that require a reboot (kernel, glibc, openssl). The maintenance subsystem checks this sentinel file — no file means no reboot.

**`maintenance_reboot: true` (default):** Reboots immediately after updates if required. Suitable for scheduled maintenance windows. Required for kernel updates to take effect.

**Deferring reboots:** Set `maintenance_reboot: false` to skip the reboot step. Run `playbooks/reboot-if-needed.yml` at a later time (e.g., off-peak hours) to apply the deferred reboot.

```bash
# Update now, reboot later
ansible-playbook playbooks/maintenance.yml -e "maintenance_reboot=false"

# Reboot when ready
ansible-playbook playbooks/reboot-if-needed.yml
```

After any reboot, `maintenance.yml` automatically runs relay verification to confirm the relay survived intact.

### Firewall Persistence After Upgrades

**UFW keep mode** (`manage_ufw: keep`):
UFW stores rules in `/etc/ufw/before.rules` — a config file that persists across reboots and kernel upgrades. After reboot, UFW starts automatically via systemd and reloads all rules. No manual intervention needed. After a `ufw` package upgrade, run `--tags verify` to confirm NAT rules in `before.rules` are still intact.

**iptables disable mode** (`manage_ufw: disable`):
Rules are persisted in `/etc/iptables/rules.v4` by `netfilter-persistent`. This is a systemd service that loads saved rules at boot. A kernel upgrade does not wipe this file. After reboot, rules are restored automatically by `netfilter-persistent.service`. If the service fails to start after a kernel upgrade, the health checks will catch it (assertion on `rules.v4` existence and ip_forward).

### UFW vs. iptables Mode Implications for Maintenance

**After a `ufw` package upgrade (keep mode):**
- Verify NAT rules are still in `/etc/ufw/before.rules`: the blockinfile markers should be present
- Run `ansible-playbook playbooks/relay.yml --tags verify` to confirm
- If rules are missing, re-apply: `ansible-playbook playbooks/relay.yml --tags ufw`

**After an `iptables-persistent` or `netfilter-persistent` upgrade (disable mode):**
- Verify `/etc/iptables/rules.v4` still exists and contains the correct rules
- Verify `netfilter-persistent` service is running: `systemctl status netfilter-persistent`
- If rules are missing: `ansible-playbook playbooks/relay.yml --tags iptables,persist`

**After any kernel upgrade:**
- New kernel may include updated netfilter modules. Test traffic after reboot.
- Check iptables counters: non-zero pkts/bytes means traffic is flowing.
- Health checks in `maintenance.yml` verify this automatically.

### Recommended Maintenance Workflow

**Standard monthly maintenance (routine security patches):**

```bash
# Step 1: Run full maintenance workflow
ansible-playbook playbooks/maintenance.yml

# Step 2: Review output for:
#   - ip_forward = 1 (confirmed by health check)
#   - UFW active or rules.v4 present
#   - PREROUTING/FORWARD rules present
#   - Relay config summary (confirms forwarding config)

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

# Verify relay after reboot
ansible-playbook playbooks/relay.yml --tags verify
```

### Example Commands

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

# Disable unattended-upgrades on relay nodes
ansible-playbook playbooks/maintenance.yml \
  -e "manage_unattended_upgrades=false" --tags unattended

# With password authentication
ansible-playbook playbooks/maintenance.yml --ask-pass
```

### Post-Update Verification Checklist

After any maintenance run, confirm the following in the output:

**Critical (must pass):**
- [ ] `net.ipv4.ip_forward = 1` — shown in health check
- [ ] UFW status active (keep mode) OR `/etc/iptables/rules.v4` exists (disable mode)
- [ ] PREROUTING has DNAT rules for `port_a_udp` and `port_a_tcp`
- [ ] FORWARD chain has ACCEPT rules for `ip_b`

**Important (review warnings):**
- [ ] `rp_filter = 2` for `conf.all` and `conf.default` — asymmetric routing requires loose mode
- [ ] `/etc/sysctl.d/99-vpn-relay.conf` exists — ensures sysctl survives reboot
- [ ] No unexpected packages removed (review dist-upgrade output if applicable)

**After reboot only:**
- [ ] `netfilter-persistent` service running (disable mode): `systemctl status netfilter-persistent`
- [ ] UFW service running (keep mode): `systemctl status ufw`
- [ ] Test VPN client can connect and route traffic through the relay

### Troubleshooting After Kernel Upgrade

**Rules missing after reboot (iptables disable mode):**

```bash
# Check netfilter-persistent service
# (run on the server or via Ansible ad-hoc)
# Re-apply iptables rules:
ansible-playbook playbooks/relay.yml --tags iptables,persist
```

**UFW not loading NAT rules after reboot (UFW keep mode):**

```bash
# Verify blockinfile markers are still in before.rules:
#   grep "BEGIN VPN-RELAY NAT" /etc/ufw/before.rules
# If missing, re-inject NAT rules:
ansible-playbook playbooks/relay.yml --tags ufw
```

**`net.ipv4.ip_forward = 0` after reboot:**

```bash
# The sysctl config file may have been lost or sysctl failed to reload.
# Re-apply:
ansible-playbook playbooks/relay.yml --tags sysctl
```

**VPN clients connect but traffic stops flowing:**

```bash
# Check PREROUTING counters (pkts/bytes should increment with traffic):
#   iptables -t nat -L PREROUTING -n -v
# If rules exist but no traffic: verify ip_b is reachable from the relay
#   ping -c 3 <ip_b>
# If no DNAT rules: re-apply the relay role
ansible-playbook playbooks/relay.yml
```

**Post-kernel-upgrade iptables behavior change:**

Some kernel updates include updated netfilter modules that may affect connection tracking behavior. If traffic stops flowing after a kernel upgrade even with correct rules:

```bash
# Check dmesg for netfilter-related errors:
#   dmesg | grep -i netfilter
# Verify conntrack table isn't full:
#   sysctl net.netfilter.nf_conntrack_count
#   sysctl net.netfilter.nf_conntrack_max
# Re-apply the full relay role to reset all rules:
ansible-playbook playbooks/relay.yml
```

### Risks of Unattended-Upgrades on Relay Nodes

The `unattended-upgrades` package provides automatic background security updates. While valuable for general servers, it carries specific risks for relay nodes:

**Automatic reboot risk:** If `Unattended-Upgrade::Automatic-Reboot "true"` is set in `/etc/apt/apt.conf.d/50unattended-upgrades` (Ubuntu default is `false`, but some configurations set it to `true`), the relay server may reboot in the background after a kernel update. All active VPN tunnels will drop without warning.

**Rule restoration window:** Even with correct persistence, there is a brief period after reboot during which the relay is not forwarding traffic (while systemd starts UFW or netfilter-persistent). For latency-sensitive applications, this is unavoidable.

**Recommendation for relay nodes:**
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

## Troubleshooting

### Verify IP Forwarding

```bash
sysctl net.ipv4.ip_forward
# Should show: net.ipv4.ip_forward = 1
```

### Check NAT Rules

```bash
# PREROUTING (DNAT)
sudo iptables -t nat -L PREROUTING -n -v

# POSTROUTING (MASQUERADE)
sudo iptables -t nat -L POSTROUTING -n -v
```

### Check FORWARD Rules

```bash
sudo iptables -L FORWARD -n -v
```

### Check UFW Status (keep mode)

```bash
sudo ufw status verbose
```

### Verify Relay with tcpdump

On Server A, capture traffic:

```bash
# Watch incoming UDP on entry port
sudo tcpdump -i eth0 udp port 51821 -n

# Watch forwarded UDP to Server B
sudo tcpdump -i eth0 udp port 51820 and host 10.0.0.2 -n

# Watch both directions
sudo tcpdump -i eth0 '(udp port 51821) or (udp port 51820 and host 10.0.0.2)' -n
```

### Test Connectivity

From client:
```bash
# Test UDP relay (WireGuard)
nc -u -v SERVER_A_IP 51821

# Test TCP relay (XRay)
nc -v SERVER_A_IP 8443
```

### Common Issues

1. **Connection timeout**: Check that `ip_b` is reachable from Server A
2. **Asymmetric routing**: Verify `rp_filter` is set to loose mode (2)
3. **UFW blocking**: Ensure entry ports are allowed in UFW
4. **Rules not persisting**: Check the correct persistence method for your mode

## Project Structure

```
vpn-relay/
├── ansible.cfg
├── inventory/
│   ├── inventory.ini
│   └── group_vars/
│       └── all.yml
├── playbooks/
│   ├── relay.yml                    # Deploy/configure relay
│   ├── rollback.yml                 # Remove relay configuration
│   ├── update.yml                   # Safe package update (no reboot)
│   ├── upgrade.yml                  # dist-upgrade (maintenance window)
│   ├── reboot-if-needed.yml         # Conditional reboot
│   └── maintenance.yml              # Full maintenance orchestrator
├── roles/
│   ├── relay/                       # Relay configuration role (do not modify)
│   │   ├── defaults/
│   │   │   └── main.yml
│   │   ├── tasks/
│   │   │   ├── main.yml
│   │   │   ├── validate.yml
│   │   │   ├── sysctl.yml
│   │   │   ├── ufw_keep.yml
│   │   │   ├── ufw_disable.yml
│   │   │   ├── iptables.yml
│   │   │   ├── persist.yml
│   │   │   └── verify.yml
│   │   ├── handlers/
│   │   │   └── main.yml
│   │   └── templates/
│   │       └── ufw-before-rules.j2
│   └── maintenance/                 # Maintenance role (separate from relay)
│       ├── defaults/
│       │   └── main.yml             # do_dist_upgrade, manage_unattended_upgrades, maintenance_reboot
│       └── tasks/
│           ├── main.yml             # Task orchestrator
│           ├── update.yml           # apt update + safe upgrade
│           ├── upgrade.yml          # dist-upgrade
│           ├── reboot.yml           # Conditional reboot
│           ├── health.yml           # Health assertions + diagnostics
│           └── unattended_upgrades.yml  # Manage unattended-upgrades
└── README.md
```

## Requirements

- Ansible 2.10+
- Target: Ubuntu 22.04 or 24.04
- `sshpass` (for password authentication)
- Collections:
  - `ansible.posix`
  - `community.general`

Install dependencies:
```bash
# On Ubuntu/Debian (control node)
sudo apt install ansible sshpass -y

# Install Ansible collections
ansible-galaxy collection install ansible.posix community.general
```

## Running from Windows (WSL2)

Ansible control nodes don't run natively on Windows. Use WSL2 (Windows Subsystem for Linux).

### Install WSL2

Open PowerShell as Administrator:

```powershell
wsl --install
```

Restart your computer when prompted. On first boot, WSL will ask you to create a Linux username and password.

### Enter WSL2

From PowerShell, Command Prompt, or Windows Terminal:

```powershell
wsl
```

Or search for "Ubuntu" in the Start menu.

### Setup Ansible in WSL2

```bash
# Update packages and install Ansible
sudo apt update && sudo apt install ansible sshpass -y

# Install required collections
ansible-galaxy collection install ansible.posix community.general
```

**Note:** `sshpass` is required for password authentication (`--ask-pass`).

### Access the Project

Windows drives are mounted under `/mnt/` in WSL2:

```bash
# Navigate to the project
cd /mnt/c/Users/YOUR_USERNAME/Projects/vpn-relay

# Verify files are accessible
ls -la
```

### SSH Keys

SSH keys should be in WSL2's home directory, not Windows:

```bash
# Create .ssh directory
mkdir -p ~/.ssh && chmod 700 ~/.ssh

# Option 1: Copy existing key from Windows
cp /mnt/c/Users/YOUR_USERNAME/.ssh/id_rsa ~/.ssh/
cp /mnt/c/Users/YOUR_USERNAME/.ssh/id_rsa.pub ~/.ssh/
chmod 600 ~/.ssh/id_rsa

# Option 2: Generate new key
ssh-keygen -t ed25519 -C "your_email@example.com"

# Copy public key to your servers
ssh-copy-id ubuntu@YOUR_SERVER_IP
```

### Run the Playbook

```bash
cd /mnt/c/Users/YOUR_USERNAME/Projects/vpn-relay

# Edit inventory with your server details
nano inventory/inventory.ini

# Run the playbook (with password prompt)
ansible-playbook playbooks/relay.yml -e "ip_b=10.0.0.2" --ask-pass
```

### Tips

- Use Windows Terminal for a better WSL2 experience
- VS Code with "Remote - WSL" extension lets you edit files directly in WSL2
- If you get permission errors on `/mnt/c/`, run: `sudo chmod 755 /mnt/c`

## License

MIT
