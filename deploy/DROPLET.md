# Rodar o Paperclip num droplet (imagem pré-buildada do ghcr)

A imagem é buildada noutra máquina e publicada no GitHub Container Registry
(`ghcr.io/danielbbarcelos/paperclip`). No droplet você **só faz pull e sobe** — não precisa do
código-fonte nem buildar nada.

Você precisa de **2 arquivos** no droplet: `deploy/docker-compose.droplet.yml` (deste repo) e um
`.env` ao lado dele.

---

## 1. Pré-requisitos no droplet

Ubuntu 22.04/24.04, e Docker + plugin compose. Se não tiver Docker:

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # depois faça logout/login
```

## 2. Copie o compose e gere o `.env`

```sh
mkdir -p ~/paperclip && cd ~/paperclip

# Traga o compose (scp do seu repo, ou baixe do seu fork):
#   scp deploy/docker-compose.droplet.yml usuario@droplet:~/paperclip/
# ou
curl -fsSL -o docker-compose.droplet.yml \
  https://raw.githubusercontent.com/danielbbarcelos/paperclip/master/deploy/docker-compose.droplet.yml

# Gere segredos fortes e um .env (chmod 600):
umask 077
cat > .env <<EOF
POSTGRES_USER=paperclip
POSTGRES_DB=paperclip
POSTGRES_PASSWORD=$(openssl rand -hex 24)
BETTER_AUTH_SECRET=$(openssl rand -base64 48)
PAPERCLIP_PUBLIC_URL=http://localhost:3100
PAPERCLIP_DEPLOYMENT_EXPOSURE=private
PAPERCLIP_MIGRATION_AUTO_APPLY=true
PAPERCLIP_SECRETS_MASTER_KEY=$(openssl rand -base64 32)
PAPERCLIP_DB_BACKUP_ENCRYPTED=true
PAPERCLIP_DB_BACKUP_KEY=$(openssl rand -base64 32)
PAPERCLIP_SOFT_DELETE_GRACE_DAYS=30
EOF
chmod 600 .env
```

> **Guarde `PAPERCLIP_DB_BACKUP_KEY` em local seguro e separado** — sem ela um backup `.enc`
> não pode ser restaurado.

## 3. Autentique no ghcr (se o pacote for privado)

Pacotes novos no ghcr são **privados** por padrão. Duas opções:

- **Deixar privado** e logar no droplet com um PAT de leitura (`read:packages`):
  ```sh
  docker login ghcr.io -u danielbbarcelos   # cole o token no prompt
  ```
- **Tornar público** no GitHub (Packages → o pacote → Package settings → Change visibility →
  Public). Aí o `docker pull` funciona sem login.

## 4. Pull e suba

```sh
docker compose -f docker-compose.droplet.yml pull
docker compose -f docker-compose.droplet.yml up -d
```

Abra `http://<IP-do-droplet>:3100`.

## 5. Claim do board (primeiro admin)

Na primeira subida em modo `authenticated`, o servidor emite uma URL de claim no log:

```sh
docker compose -f docker-compose.droplet.yml logs server | grep board-claim
```

Logado na UI, acesse essa URL para virar administrador da instância.

---

## Atualizar para uma nova imagem

Quando uma nova imagem for publicada:

```sh
docker compose -f docker-compose.droplet.yml pull
docker compose -f docker-compose.droplet.yml up -d
```

Para fixar uma versão específica em vez de `latest`, defina no `.env`:

```sh
PAPERCLIP_IMAGE=ghcr.io/danielbbarcelos/paperclip:3083e06a
```

## Operação

```sh
C="docker compose -f docker-compose.droplet.yml"
$C ps           # status
$C logs -f      # logs
$C down         # parar (dados persistem nos volumes pgdata / paperclip-data)
```

---

## Expor publicamente

Para internet-facing, no `.env` mude:

```sh
PAPERCLIP_DEPLOYMENT_EXPOSURE=public
PAPERCLIP_PUBLIC_URL=https://paperclip.seu-dominio.com
TRUST_PROXY=1
```

E coloque um **proxy reverso com TLS** (Caddy/nginx) na frente da porta 3100. Se usar
cloud-tenant, defina também `PAPERCLIP_CLOUD_TENANT_HMAC_KEY`. Detalhes e checklist completo em
[`UBUNTU_DEPLOY.md`](./UBUNTU_DEPLOY.md).
