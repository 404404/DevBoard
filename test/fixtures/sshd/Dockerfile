FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-server git \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/sh devboard \
  && mkdir -p /run/sshd /home/devboard/workspace /usr/local/lib/devboard \
  && chown -R devboard:devboard /home/devboard

COPY sshd_config /etc/ssh/sshd_config
COPY fake-codex.mjs /usr/local/lib/devboard/fake-codex.mjs
COPY codex /usr/local/bin/codex
COPY entrypoint.sh /usr/local/bin/fixture-entrypoint
RUN chmod 0755 /usr/local/bin/codex /usr/local/bin/fixture-entrypoint \
  && runuser -u devboard -- git -C /home/devboard/workspace init -q \
  && runuser -u devboard -- git -C /home/devboard/workspace config user.name 'CI SSH Fixture' \
  && runuser -u devboard -- git -C /home/devboard/workspace config user.email 'fixture@example.invalid' \
  && runuser -u devboard -- sh -c 'printf remote-only > /home/devboard/workspace/.devboard-remote-fixture && git -C /home/devboard/workspace add . && git -C /home/devboard/workspace commit -qm fixture'

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/fixture-entrypoint"]
