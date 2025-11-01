FROM ghcr.io/coder/code-server:latest

USER root
# Instala Python, Node, git, etc. (puedes añadir más herramientas)
RUN apt-get update && \
    apt-get install -y python3 python3-pip git curl && \
    rm -rf /var/lib/apt/lists/*

USER 1000
WORKDIR /home/coder/project
COPY . .

# Render necesita saber qué puerto usar
ENV PORT=8080
EXPOSE 8080

CMD ["code-server", "--bind-addr", "0.0.0.0:8080", "--auth", "password", "/home/coder/project"]