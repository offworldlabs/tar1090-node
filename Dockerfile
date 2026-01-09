FROM debian:bullseye-slim

RUN apt-get update && apt-get install -y \
    lighttpd \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /usr/local/share/tar1090/html

COPY html/ /usr/local/share/tar1090/html/
RUN mkdir -p /run/readsb
COPY data/ /run/readsb/
RUN chmod -R a+r /run/readsb/
COPY *.conf /usr/local/share/tar1090/
COPY *.sh /usr/local/share/tar1090/
RUN chmod +x /usr/local/share/tar1090/*.sh

# Copy lighttpd configs
COPY docker/lighttpd-tar1090.conf /etc/lighttpd/conf-available/89-tar1090.conf
COPY docker/lighttpd-proxy.conf /etc/lighttpd/conf-available/90-proxy.conf
RUN lighttpd-enable-mod tar1090 && lighttpd-enable-mod proxy

# Copy proxy server
COPY proxy/server.js /opt/proxy/server.js

# Configure lighttpd: port 80, document root
RUN sed -i 's/server.port\s*=.*/server.port = 80/' /etc/lighttpd/lighttpd.conf && \
    sed -i 's|server.document-root\s*=.*|server.document-root = "/usr/local/share/tar1090/html/"|' /etc/lighttpd/lighttpd.conf

COPY <<'EOF' /usr/local/bin/start.sh
#!/bin/bash
set -e

cleanup() {
    echo "Shutting down..."
    kill $PROXY_PID 2>/dev/null || true
    kill $LIGHTTPD_PID 2>/dev/null || true
    exit 0
}
trap cleanup SIGTERM SIGINT

echo "Starting aircraft data proxy on port ${PROXY_PORT:-3005}..."
node /opt/proxy/server.js &
PROXY_PID=$!

sleep 1
echo "Starting tar1090 web interface on port 80..."
lighttpd -D -f /etc/lighttpd/lighttpd.conf &
LIGHTTPD_PID=$!

# Wait for either process to exit
wait -n
exit_code=$?
echo "Process exited with code $exit_code, shutting down..."
cleanup
exit $exit_code
EOF

RUN chmod +x /usr/local/bin/start.sh

EXPOSE 80

CMD ["/usr/local/bin/start.sh"]
