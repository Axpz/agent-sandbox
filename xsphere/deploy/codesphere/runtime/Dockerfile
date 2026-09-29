FROM xsphere-runtime:envd-0.6.9 AS envd

FROM nexus.service.consul:5000/e2bdev/base/agentsphere-codesphere-pi-base:latest

# tini remains PID 1 above envd's shell supervisor loop. It reaps the
# orphans a shell leaves behind and forwards signals to the child process
# group, which a shell blocked on a foreground child cannot do itself.
RUN apt-get update && \
    apt-get install -y --no-install-recommends tini && \
    rm -rf /var/lib/apt/lists/*

# The base image already contains the daemon and its dependencies. Replace its
# build-oriented setup script with the runtime lifecycle used by this stack.
COPY setup_codesphere.sh /usr/local/bin/setup_codesphere.sh
COPY entrypoint.sh /usr/local/bin/codesphere-entrypoint
COPY envd-recover.sh /usr/local/bin/envd-recover
RUN chmod 0755 \
      /usr/local/bin/setup_codesphere.sh \
      /usr/local/bin/codesphere-entrypoint \
      /usr/local/bin/envd-recover && \
    bash -n /usr/local/bin/setup_codesphere.sh

COPY --from=envd /usr/local/bin/envd /usr/local/bin/envd

# Backend sandbox.py starts daemon with its assigned ID after writing the token.
COPY start-up.sh /root/.jupyter/start-up.sh
RUN chmod 0755 /root/.jupyter/start-up.sh

# The base image assumes the real agentsphere/e2b runtime creates this account
# when a sandbox boots. Our envd does not, so this runtime creates it instead;
# envd's files API chowns to "user" on every write.
#
# Deliberately no `chown -R /home/user` here: the base image already populated
# it with the Pi extensions, and a recursive chown would force overlayfs to
# copy every file into this layer. The base image ships /etc/codesphere and
# /mnt/user-data as 0777 for this pre-account-creation window; start_application
# applies the final ownership once "user" exists at runtime.
RUN useradd -m -s /bin/bash -u 1000 user && \
    echo "user ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/user && \
    chmod 0440 /etc/sudoers.d/user

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/codesphere-entrypoint"]
CMD []
