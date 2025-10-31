# syntax=docker/dockerfile:1
FROM node:20-slim
ENV DEBIAN_FRONTEND=noninteractive

# Dependencias Chromium/Playwright + entorno gráfico + herramientas de red PARA Tailscale kernel TUN
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget xz-utils \
    libnss3 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 \
    libxfixes3 libxi6 libxrender1 libxrandr2 libxtst6 libglib2.0-0 \
    libatk1.0-0 libatk-bridge2.0-0 libdrm2 libgbm1 libasound2 \
    libxkbcommon0 libgtk-3-0 fonts-liberation \
    xvfb x11vnc fluxbox novnc websockify \
    # ← imprescindibles para tailscaled en modo kernel (no userspace)
    iproute2 iptables iputils-ping procps python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev
RUN npx playwright install --with-deps chromium

# ============================================
# 🧠 ENTORNO PYTHON (añadido)
# ============================================

# Crear entorno virtual Python
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copiar dependencias Python si existen
COPY requirements.txt ./
RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi

# ============================================
# Tailscale binarios
# ============================================
ARG TS_VER=1.70.0
RUN curl -fsSL https://pkgs.tailscale.com/stable/tailscale_${TS_VER}_amd64.tgz \
  | tar -xz -C /usr/local/bin --strip-components=1 \
      tailscale_${TS_VER}_amd64/tailscale \
      tailscale_${TS_VER}_amd64/tailscaled

# Tu código
COPY . .
RUN chmod +x /app/start.sh

# State de tailscale PERSISTENTE
VOLUME ["/var/lib/tailscale"]

# Puertos de tu app/noVNC (nota: si usas --network=host en Linux, Docker ignorará EXPOSE)
EXPOSE 10000 6080

# Vars por defecto
ENV NODE_ENV=production
ENV HEADLESS=true
ENV XVFB_RESOLUTION=1920x1080x24
ENV TS_STATE_FILE=/var/lib/tailscale/tailscaled.state
# ENV TS_HOSTNAME=render-osint   # opcional

CMD ["/app/start.sh"]
