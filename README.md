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
│   ├── relay.yml
│   └── rollback.yml
├── roles/
│   └── relay/
│       ├── defaults/
│       │   └── main.yml
│       ├── tasks/
│       │   ├── main.yml
│       │   ├── validate.yml
│       │   ├── sysctl.yml
│       │   ├── ufw_keep.yml
│       │   ├── ufw_disable.yml
│       │   ├── iptables.yml
│       │   ├── persist.yml
│       │   └── verify.yml
│       ├── handlers/
│       │   └── main.yml
│       └── templates/
│           └── ufw-before-rules.j2
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
