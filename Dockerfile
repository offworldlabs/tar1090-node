FROM debian:bullseye-slim

RUN apt-get update && apt-get install -y \
    nginx \
    lighttpd \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /usr/local/share/tar1090/html

COPY html/ /usr/local/share/tar1090/html/
COPY *.conf /usr/local/share/tar1090/
COPY *.sh /usr/local/share/tar1090/
RUN chmod +x /usr/local/share/tar1090/*.sh

COPY docker/lighttpd-tar1090.conf /etc/lighttpd/conf-available/89-tar1090.conf
RUN lighttpd-enable-mod tar1090

COPY <<'EOF' /usr/local/bin/start.sh
#!/bin/bash
set -e

echo "Starting tar1090 web interface on port 8504..."
lighttpd -D -f /etc/lighttpd/lighttpd.conf
EOF

RUN chmod +x /usr/local/bin/start.sh

EXPOSE 8504

CMD ["/usr/local/bin/start.sh"]
