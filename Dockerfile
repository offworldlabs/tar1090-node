FROM ghcr.io/sdr-enthusiasts/docker-tar1090:latest

# Install Node.js for our adsb.lol proxy
RUN apt-get update && apt-get install -y nodejs npm && rm -rf /var/lib/apt/lists/*

# Copy our proxy server (reads from file, avoids circular dependency)
COPY proxy/server.js /opt/proxy/server.js

# Runtime nginx config injection - runs AFTER 07-nginx-configure regenerates config
# Must be numbered > 07 to run after nginx config is generated
# (Build-time sed doesn't persist because tar1090 regenerates nginx config at startup)
COPY docker/08-inject-proxy-config /etc/s6-overlay/startup.d/08-inject-proxy-config
RUN chmod +x /etc/s6-overlay/startup.d/08-inject-proxy-config

# Start proxy as a background service using s6-overlay cont-init
COPY docker/01-start-proxy /etc/cont-init.d/01-start-proxy
RUN chmod +x /etc/cont-init.d/01-start-proxy
