#!/usr/bin/env bash
set -euo pipefail

# Run as the startup script on the dedicated LittleTake Ubuntu VM.
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl docker.io docker-compose-v2
systemctl enable --now docker

disk=/dev/disk/by-id/google-littletake-data
test -b "$disk"
filesystem=$(blkid -s TYPE -o value "$disk" || true)
if [ -z "$filesystem" ]; then
    # This named disk is created empty by the LittleTake VM provisioning step.
    test "$(blockdev --getsize64 "$disk")" -eq 53687091200
    mkfs.ext4 -L littletake-data "$disk"
elif [ "$filesystem" != ext4 ]; then
    echo 'The data disk has an unexpected filesystem; leaving it untouched.' >&2
    exit 1
fi
install -d -m 0755 /srv/littletake /opt/littletake
uuid=$(blkid -s UUID -o value "$disk")
if ! grep -q "^UUID=$uuid " /etc/fstab; then
    printf 'UUID=%s /srv/littletake ext4 defaults 0 2\n' "$uuid" >> /etc/fstab
fi
mountpoint -q /srv/littletake || mount /srv/littletake
install -d -m 0700 /etc/littletake /srv/littletake/data /srv/littletake/backups
touch /var/lib/littletake-bootstrap.ready
