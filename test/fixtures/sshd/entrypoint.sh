#!/bin/sh
set -eu
mkdir -p /run/sshd
if [ ! -s /etc/ssh/ssh_host_ed25519_key ]; then
  ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
fi
exec /usr/sbin/sshd -D -e
