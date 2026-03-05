# Troubleshooting

## WireGuard Cascade

### Check WireGuard interface status

```bash
# On both servers
sudo wg show all

# Expected output on Server A:
#   interface: wg-uplink
#     peer: <B's pubkey>
#     endpoint: <server_b_public_ip>:51821
#     latest handshake: <recent>
#     transfer: ...
#   interface: wg-clients
#     peer: <client pubkey>
#     latest handshake: <recent>
```

### Check policy routing (Server A)

```bash
sudo ip rule show
# Must include: 200: from 10.66.0.0/24 lookup 200

sudo ip route show table 200
# Must include: default dev wg-uplink
```

If missing, check that `wg-quick@wg-uplink` started successfully:
```bash
systemctl status wg-quick@wg-uplink
journalctl -u wg-quick@wg-uplink --no-pager -n 30
```

### Check NAT and forwarding rules

```bash
# Server A: MASQUERADE from client subnet out wg-uplink
sudo iptables -t nat -L POSTROUTING -n -v

# Server B: MASQUERADE from uplink subnet out WAN
sudo iptables -t nat -L POSTROUTING -n -v

# Check FORWARD chain (both servers)
sudo iptables -S FORWARD
```

### Client cannot reach the internet

Typical causes in order:

1. **wg-uplink not peered** — `wg show wg-uplink` shows no `latest handshake`. Check that port `wg_uplink_port_b` is open on Server B (not blocked by B's UFW), and that `server_b_public_ip` is correct.

2. **ip rule missing on A** — `ip rule show` does not contain `from 10.66.0.0/24 lookup 200`. Means `wg-quick@wg-uplink` didn't run PostUp. Restart: `sudo systemctl restart wg-quick@wg-uplink`.

3. **MASQUERADE missing on B** — `iptables -t nat -L POSTROUTING -n -v` on B shows no rule for `10.200.0.0/30`. Re-run: `ansible-playbook playbooks/wg_cascade.yml --tags firewall`.

4. **Port conflict on Server B** — If another WireGuard instance is using port 51820 and B's firewall blocks `wg_uplink_port_b`. Open it: re-run cascade with `--tags firewall` or allow the port manually.

5. **wg-clients started before wg-uplink** — `ip route show table 200` is empty. Restart in order:
   ```bash
   sudo systemctl restart wg-quick@wg-uplink
   sudo systemctl restart wg-quick@wg-clients
   ```

### Controller missing wireguard-tools

The controller needs `wireguard-tools` for key operations during stack deploy:
```bash
sudo apt install wireguard-tools   # Ubuntu/Debian
```

### wg_uplink_port_b hard-fail at 51820

Port 51820 is the WireGuard default and may already be in use on Server B. Use a different port:
```yaml
# inventory/group_vars/wg_cascade.yml
wg_uplink_port_b: 51821
```
Or if you have confirmed 51820 is free on B:
```bash
ansible-playbook playbooks/wg_cascade.yml -e "wg_uplink_allow_default_port=true"
```

### apt hangs or OOM during package installation (low RAM)

Low-RAM servers may not have enough free memory for apt. The `--tags validate`
pre-check will warn if free RAM is below 128 MB. Add swap automatically:

```bash
ansible-playbook playbooks/maintenance_add_swap.yml
```

Or manually on the server (survives reboots):

```bash
fallocate -l 1G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Then verify: `free -h` should show swap available.

---

## XRay Relay

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
sudo tcpdump -i eth0 udp port 51820 and host <server_b_ip> -n

# Watch both directions
sudo tcpdump -i eth0 '(udp port 51821) or (udp port 51820 and host <server_b_ip>)' -n
```

### Test Connectivity

From client:
```bash
# Test TCP relay (XRay)
nc -v SERVER_A_IP 443
```

### Common Issues

1. **Connection timeout**: Check that `server_b_public_ip` is reachable from Server A
2. **Asymmetric routing**: Verify `rp_filter` is set to loose mode (2)
3. **UFW blocking**: Ensure entry ports are allowed in UFW
4. **Rules not persisting**: Check the correct persistence method for your mode

---

## Post-Kernel-Upgrade Issues

### Rules missing after reboot (iptables disable mode)

```bash
# Check netfilter-persistent service
# Re-apply iptables rules:
ansible-playbook playbooks/relay.yml --tags iptables,persist
```

### UFW not loading NAT rules after reboot (UFW keep mode)

```bash
# Verify blockinfile markers are still in before.rules:
#   grep "BEGIN VPN-RELAY NAT" /etc/ufw/before.rules
# If missing, re-inject NAT rules:
ansible-playbook playbooks/relay.yml --tags ufw
```

### `net.ipv4.ip_forward = 0` after reboot

```bash
# The sysctl config file may have been lost or sysctl failed to reload.
# Re-apply:
ansible-playbook playbooks/relay.yml --tags sysctl
```

### VPN clients connect but traffic stops flowing

```bash
# Check PREROUTING counters (pkts/bytes should increment with traffic):
#   iptables -t nat -L PREROUTING -n -v
# If rules exist but no traffic: verify server_b_public_ip is reachable from the relay
#   ping -c 3 <server_b_public_ip>
# If no DNAT rules: re-apply the relay role
ansible-playbook playbooks/relay.yml
```

### Post-kernel-upgrade iptables behavior change

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

---

## iptables backend: nft vs legacy

Ubuntu 22.04+ defaults to the nft backend for iptables. The `iptables` command
is actually `iptables-nft`. This usually works transparently, but can cause
issues when:

- Rules created by `iptables-nft` are invisible to `iptables-legacy` and vice versa
- Some Docker versions install `iptables-legacy` rules alongside nft rules

To check which backend you're using:
```bash
update-alternatives --query iptables
```

Expected output for Ubuntu 22.04+:
```
Value: /usr/sbin/iptables-nft
```

If you see `iptables-legacy` and rules appear missing, switch:
```bash
sudo update-alternatives --set iptables /usr/sbin/iptables-nft
sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-nft
```

Then re-apply: `ansible-playbook playbooks/wg_cascade.yml --tags firewall`
