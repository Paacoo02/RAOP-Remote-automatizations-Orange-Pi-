# syntax=docker/dockerfile:1.6
# ======================================================
# 💿 Imagen base
# ======================================================
FROM node:20-slim
ENV DEBIAN_FRONTEND=noninteractive

# ======================================================
# 🔧 Dependencias del sistema (entorno gráfico, Python, SSH)
# ======================================================
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    ca-certificates curl wget xz-utils gnupg openssh-server iproute2 iptables iputils-ping procps \
    python3 python3-venv python3-pip \
    xvfb x11vnc fluxbox novnc websockify xauth \
    fonts-liberation libnss3 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 \
    libxfixes3 libxi6 libxrender1 libxrandr2 libxtst6 libglib2.0-0 libatk1.0-0 libatk-bridge2.0-0 \
    libdrm2 libgbm1 libasound2 libxkbcommon0 libgtk-3-0 libgtk-4-1 libgtk-4-bin \
    libgstreamer1.0-0 gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-tools \
    fonts-freefont-ttf fonts-dejavu fonts-noto-color-emoji \
    libatomic1 libevent-2.1-7 libavif15 libharfbuzz-icu0 libenchant-2-2 \
    libsecret-1-0 libhyphen0 libmanette-0.2-0 libxss1 dos2unix; \
  if apt-cache show libwoff2dec1 >/dev/null 2>&1; then \
    apt-get install -y --no-install-recommends libwoff2dec1; \
  elif apt-cache show libwoff2-1 >/dev/null 2>&1; then \
    apt-get install -y --no-install-recommends libwoff2-1; \
  elif apt-cache show libwoff1 >/dev/null 2>&1; then \
    apt-get install -y --no-install-recommends libwoff1; \
  else \
    echo "Aviso: paquete WOFF(2) no encontrado, continuamos..."; \
  fi; \
  rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. Copiamos SOLO los ficheros de dependencias primero
COPY package*.json ./

# 2. Instalamos TODAS las dependencias definidas en tu package.json
RUN npm install

# 3. Instalamos los navegadores de Playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN mkdir -p /ms-playwright && chown -R root:root /ms-playwright
RUN npx playwright install --with-deps chromium

# Si en el futuro tu script usa más librerías, añádelas aquí, por ejemplo:
# RUN npm install --omit=dev qrcode-terminal whatsapp-web.js

# ======================================================
# 🔐 Configuración de SSH
# ======================================================
RUN useradd -ms /bin/bash devuser && echo "devuser:devpass" | chpasswd && \
    echo "root:root" | chpasswd && mkdir -p /var/run/sshd && \
    sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config && \
    sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config && \
    echo "AllowUsers devuser root" >> /etc/ssh/sshd_config

# ======================================================
# ⚙️ Copia del código
# ======================================================
# En tu caso solo existen app.js y Dockerfile, así que copiamos todo
COPY . .

# Normaliza scripts .sh (si los añades después) y marca ejecutables
RUN find /app -type f -name "*.sh" -exec dos2unix {} \; -exec chmod +x {} \; || true

EXPOSE 2222 6081 5901 3001

# ======================================================
# 🌙 Configuración del entorno
# ======================================================
ENV NODE_ENV=production \
    DISPLAY=:99 \
    XVFB_RESOLUTION=1920x1080x24 \
    HEADLESS=false

# ======================================================
# 🚀 Comando de arranque
#  - Ejecuta clear_ssh_host.sh SOLO si existe
#  - Arranca SSH y deja el contenedor vivo
# ======================================================
CMD ["/bin/bash", "-c", "if [ -f /app/clear_ssh_host.sh ]; then /app/clear_ssh_host.sh; fi && service ssh restart && echo '🟢 SSH en ejecución (puerto 22)' && while true; do sleep 3600; done"]
