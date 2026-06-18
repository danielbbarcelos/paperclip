# Deploy do Paperclip num Ubuntu do zero

Guia para subir o Paperclip numa máquina **Ubuntu limpa** usando Docker, com as defesas de
segurança já configuradas. O provisionamento é feito por um único script Python que mostra
progresso, instala o que falta, gera os segredos e registra logs de tudo.

> **TL;DR**
> ```sh
> git clone <url-do-repo> paperclip && cd paperclip
> sudo python3 deploy/provision_ubuntu.py
> ```
> Ao final, abra `http://<IP-do-host>:3100`.

---

## O que é provisionado

Dois containers via `docker compose`:

- **db** — PostgreSQL 17 (sem senha default; porta presa em `127.0.0.1:5432`).
- **server** — o Paperclip (UI + API) na porta `3100`, buildado a partir do `Dockerfile`.

Modo de execução: **`authenticated`** (login exigido). Exposição **`private`** por padrão
(rede confiável: LAN/VPN/Tailscale) ou **`public`** (internet-facing, atrás de proxy reverso).

### Defesas de segurança ligadas por padrão
O script já configura o hardening implementado no projeto:

| Recurso | Como vem configurado |
|---|---|
| Senha do Postgres forte | gerada (`POSTGRES_PASSWORD`), Postgres recusa subir sem ela |
| Segredo de auth forte | `BETTER_AUTH_SECRET` gerado (48 bytes); o dev-secret é rejeitado |
| Backups criptografados em repouso (AES-256-GCM) | `PAPERCLIP_DB_BACKUP_ENCRYPTED=true` + `PAPERCLIP_DB_BACKUP_KEY` gerada |
| Master key de segredos fixa | `PAPERCLIP_SECRETS_MASTER_KEY` gerada (consistência de backups) |
| Soft-delete recuperável | `PAPERCLIP_SOFT_DELETE_GRACE_DAYS=30` (delete vira lixeira com janela de graça) |
| Migrations aplicadas no 1º boot | `PAPERCLIP_MIGRATION_AUTO_APPLY=true` |
| Rate limit, SSRF guard, gate de import RCE, allowlist de credenciais de plugin | já no código; ativam-se conforme o uso |

Em **exposição pública** o script também define `TRUST_PROXY=1` (necessário para o rate
limiting por cliente funcionar atrás de um proxy reverso).

---

## Pré-requisitos

- Ubuntu/Debian (apt) com acesso `sudo`.
- `python3` (já vem no Ubuntu) — o script usa só a biblioteca padrão, sem `pip`.
- O código do Paperclip (este repositório) na máquina.
- Acesso à internet para baixar imagens/dependências.

O script instala sozinho, se faltarem: `ca-certificates`, `curl`, `git`, `openssl`, `gnupg`,
**Docker Engine** e o **plugin docker compose** (via repositório oficial do Docker).

---

## Uso

### Privado (default — login + rede confiável)
```sh
sudo python3 deploy/provision_ubuntu.py
```

### Público (internet-facing)
```sh
sudo python3 deploy/provision_ubuntu.py \
  --exposure public \
  --public-url https://paperclip.exemplo.com
```
> Em público você **precisa** colocar um proxy reverso com TLS na frente da porta `3100`
> (veja [Expor publicamente](#expor-publicamente-com-segurança)).

### Opções úteis
| Flag | Efeito |
|---|---|
| `--dry-run` | mostra tudo que faria, sem executar nada |
| `--repo-dir <path>` | raiz do repositório (default: detecta a partir do script) |
| `--port <n>` | porta HTTP no host (default 3100) |
| `--no-system-install` | não instala pacotes/Docker via apt (exige Docker já presente) |
| `--no-backup-encryption` | não habilita a criptografia de backups |
| `--health-timeout <s>` | tempo esperando o `/health` (default 180) |

O script é **idempotente**: rodar de novo preserva os segredos já gerados em `docker/.env`.

---

## O que o script faz (7 etapas)

1. **Plataforma/pré-requisitos** — confirma Ubuntu/Debian, Python 3.8+, e `sudo`.
2. **Pacotes de sistema** — instala os que faltarem.
3. **Docker** — instala Engine + compose v2 se ausentes; habilita o serviço; adiciona seu
   usuário ao grupo `docker`.
4. **Configuração** — gera `docker/.env` (chmod 600) com segredos fortes e um override
   `docker/docker-compose.deploy.yml` que injeta o `.env` no container.
5. **Build & up** — `docker compose ... up -d --build` (streama o build no console e no log).
6. **Health** — espera `GET /health` responder.
7. **Resumo** — imprime URL, caminho dos logs e comandos do dia a dia.

**Logs:** tudo é gravado em `deploy/logs/provision-<timestamp>.log`. Se algo falhar, o script
aponta o comando que quebrou e o caminho do log, e sai com código ≠ 0.

---

## Arquivos gerados (não comitar)

| Arquivo | Conteúdo |
|---|---|
| `docker/.env` | **segredos** (Postgres, auth, chaves de backup/segredos) — `chmod 600`, já no `.gitignore` |
| `docker/docker-compose.deploy.yml` | override do compose (injeta o `.env`) — já no `.gitignore` |
| `deploy/logs/*.log` | logs do provisionamento — já no `.gitignore` |

> **Backups:** a chave `PAPERCLIP_DB_BACKUP_KEY` vive no `.env` (fora do volume de dados).
> Guarde uma cópia segura dela **separada** dos backups — sem ela, um backup `.enc` não pode
> ser restaurado.

---

## Primeiro acesso e claim do board

1. Abra a URL (`http://<IP>:3100` ou sua URL pública).
2. Crie sua conta (login via Better Auth).
3. Na primeira subida em modo `authenticated`, o servidor emite **uma URL de claim** no log
   de startup:
   ```
   /board-claim/<token>?code=<code>
   ```
   Veja-a com:
   ```sh
   docker compose -f docker/docker-compose.yml -f docker/docker-compose.deploy.yml logs server | grep board-claim
   ```
4. Logado, acesse essa URL para promover sua conta a administrador da instância.

---

## Operação no dia a dia

Os comandos abaixo assumem que você está na raiz do repositório. (Se o Docker pedir `sudo`
porque você ainda não relogou após entrar no grupo `docker`, prefixe com `sudo`.)

```sh
COMPOSE="docker compose -f docker/docker-compose.yml -f docker/docker-compose.deploy.yml"

$COMPOSE ps              # status dos containers
$COMPOSE logs -f         # logs ao vivo
$COMPOSE restart server  # reiniciar só o servidor
$COMPOSE down            # parar tudo (dados persistem nos volumes)
$COMPOSE up -d --build   # atualizar após um git pull
```

### Backups do banco
Backups automáticos rodam dentro do container em intervalo periódico. Com a criptografia
ligada eles são gravados **cifrados** (`.sql.gz.enc`) no volume `paperclip-data`. Um backup
manual pode ser disparado pela área de administração da instância (UI). Para **restaurar** um
backup `.enc` é preciso ter a mesma `PAPERCLIP_DB_BACKUP_KEY` usada para criá-lo — por isso
guarde essa chave em local seguro e separado dos backups. Detalhes do banco em
`docs/deploy/database.md`.

---

## Expor publicamente com segurança

Em `--exposure public`, o app continua ouvindo HTTP na 3100; **TLS e o proxy reverso são sua
responsabilidade**. Checklist:

1. **Proxy reverso com TLS** (nginx/Caddy/Traefik) terminando HTTPS e encaminhando para a 3100.
2. **`TRUST_PROXY`** — o script define `=1`; ajuste para o número de hops/sub-rede do seu
   proxy. Sem isso, o rate limiting por cliente não funciona (o servidor **recusa subir** em
   público sem um valor explícito).
3. **`PAPERCLIP_PUBLIC_URL`** — sua URL HTTPS pública (usada para cookies e CSRF).
4. **Cloud-tenant (se usar):** se definir `PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN`, é **obrigatório**
   também definir `PAPERCLIP_CLOUD_TENANT_HMAC_KEY` (o servidor recusa subir sem ela) e fazer o
   proxy upstream assinar os headers de identidade — senão um token vazado permite impersonação
   entre tenants.
5. **Firewall** — exponha só 80/443 do proxy; não publique a 3100 nem a 5432 na internet.

Exemplo mínimo de proxy (Caddy):
```
paperclip.exemplo.com {
    reverse_proxy 127.0.0.1:3100
}
```

---

## Variáveis principais (`docker/.env`)

| Variável | Função |
|---|---|
| `POSTGRES_PASSWORD` | senha do Postgres (gerada) |
| `BETTER_AUTH_SECRET` | assina sessões/JWT (gerado, ≥24 chars) |
| `PAPERCLIP_PUBLIC_URL` | URL pública (cookies/CSRF) |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` ou `public` |
| `PAPERCLIP_MIGRATION_AUTO_APPLY` | aplica migrations no boot |
| `PAPERCLIP_SECRETS_MASTER_KEY` | criptografa segredos em repouso |
| `PAPERCLIP_DB_BACKUP_ENCRYPTED` / `PAPERCLIP_DB_BACKUP_KEY` | backups cifrados + chave |
| `PAPERCLIP_SOFT_DELETE_GRACE_DAYS` | janela de recuperação de deletes |
| `TRUST_PROXY` | (público) hops/sub-rede do proxy reverso |
| `PAPERCLIP_PLUGIN_CREDENTIAL_ALLOWLIST` | (opcional) ids de plugins que podem receber chaves de provider |

Referência completa: `docs/deploy/environment-variables.md` e `docker/.env.example`.

---

## Troubleshooting

| Sintoma | O que verificar |
|---|---|
| `/health` não responde | `$COMPOSE logs server` — geralmente migrations ou env faltando |
| "Refusing to start against a stale schema" | banco com migrations pendentes — `PAPERCLIP_MIGRATION_AUTO_APPLY=true` (o script já define) ou rode `pnpm db:migrate` |
| "POSTGRES_PASSWORD must be set" | `docker/.env` ausente/incompleto — rode o script de novo |
| `docker` pede senha / "permission denied" | você entrou no grupo `docker` mas não relogou — faça logout/login ou use `sudo docker ...` |
| Público recusa subir | falta `TRUST_PROXY` ou `PAPERCLIP_CLOUD_TENANT_HMAC_KEY` — veja a seção de exposição pública |
| Porta 3100 ocupada | pare o que usa a porta, ou ajuste `ports:` em `docker/docker-compose.yml` |

Log detalhado de cada execução: `deploy/logs/provision-<timestamp>.log`.

---

## Apêndice: sem Docker (build nativo)

O caminho suportado e recomendado é Docker. Para rodar nativamente (Node 20+ e pnpm 9), veja
`docs/deploy/local-development.md` e `docs/deploy/overview.md` — instale dependências com
`pnpm install`, builde com `pnpm build` e use a CLI `pnpm paperclipai onboard`.
