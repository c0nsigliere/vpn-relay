# TODO

## Clean up legacy Docker/Amnezia/UDP relay references

Prepare codebase for clean server deployments (no Amnezia/Docker assumed).
Everything already works on clean servers — this is cosmetic/hygiene cleanup.

- [x] `roles/xray_server/tasks/validate.yml` — remove Docker takeover block; remove `xray_takeover_443` variable
- [x] `roles/wg_cascade/tasks/validate.yml` — soften 51820 hard-fail (removed Amnezia references)
- [x] `playbooks/cascade.yml` — remove pre-tasks that clean legacy UDP relay iptables rules
- [x] `playbooks/cleanup_legacy_relay.yml` — delete the entire playbook
- [x] `README.md` — remove "(Amnezia Docker" from ASCII diagram, remove "Clean Up Legacy AWG Relay Leftovers" section
- [x] `docs/troubleshooting.md` — remove Amnezia-specific sections (51820 hard-fail, Docker memory, legacy iptables)
- [x] `roles/wg_cascade/templates/wg-uplink-b.conf.j2` — remove "Amnezia Docker containers are untouched" comment
- [x] `roles/wg_cascade/defaults/main.yml` — remove Amnezia references from comments
- [x] `inventory/inventory.ini.example` — remove "may run Amnezia Docker" from comment
- [x] `inventory/group_vars/wg_cascade.yml.example` — remove "Amnezia default" from comment
