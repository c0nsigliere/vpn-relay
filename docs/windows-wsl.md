# Running from Windows (WSL2)

Ansible control nodes don't run natively on Windows. Use WSL2 (Windows Subsystem for Linux).

## Install WSL2

Open PowerShell as Administrator:

```powershell
wsl --install
```

Restart your computer when prompted. On first boot, WSL will ask you to create a Linux username and password.

## Enter WSL2

From PowerShell, Command Prompt, or Windows Terminal:

```powershell
wsl
```

Or search for "Ubuntu" in the Start menu.

## Setup Ansible in WSL2

```bash
# Update packages and install Ansible
sudo apt update && sudo apt install ansible sshpass wireguard-tools -y

# Install required collections
ansible-galaxy collection install -r requirements.yml
```

**Note:** `sshpass` is required for password authentication (`--ask-pass`).

## Access the Project

Windows drives are mounted under `/mnt/` in WSL2:

```bash
# Navigate to the project
cd /mnt/c/Users/YOUR_USERNAME/Projects/vpn-relay

# Verify files are accessible
ls -la
```

## SSH Keys

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
ssh-copy-id root@YOUR_SERVER_IP
```

## Deploy

Follow the [Golden Path](../README.md#golden-path-fresh-install-cascade--relay) in the main README:

```bash
cd /mnt/c/Users/YOUR_USERNAME/Projects/vpn-relay

# 1. Copy and fill in inventory + group_vars
cp inventory/inventory.ini.example inventory/inventory.ini
cp inventory/group_vars/all.yml.example inventory/group_vars/all.yml
cp inventory/group_vars/wg_cascade.yml.example inventory/group_vars/wg_cascade.yml
cp inventory/group_vars/relay_servers.yml.example inventory/group_vars/relay_servers.yml

# 2. Edit files with your IPs and settings
nano inventory/inventory.ini
nano inventory/group_vars/all.yml

# 3. Deploy
ansible-playbook playbooks/wg_cascade.yml
ansible-playbook playbooks/relay.yml

# 4. Verify
ansible-playbook playbooks/verify_all.yml
```

## Tips

- Use Windows Terminal for a better WSL2 experience
- VS Code with "Remote - WSL" extension lets you edit files directly in WSL2
- If you get permission errors on `/mnt/c/`, run: `sudo chmod 755 /mnt/c`
