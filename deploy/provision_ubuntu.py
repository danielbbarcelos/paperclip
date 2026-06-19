#!/usr/bin/env python3
"""
Paperclip — provisionamento em Ubuntu do zero.

Sobe o Paperclip numa máquina Ubuntu limpa usando Docker Compose:
  1. instala dependências de sistema que faltarem (Docker Engine + plugin compose, git, openssl…);
  2. gera segredos fortes e um arquivo docker/.env idempotente (não sobrescreve segredos existentes);
  3. builda e sobe os containers (Postgres + servidor) com as defesas de segurança ligadas;
  4. aplica as migrations e espera o /health responder;
  5. grava um log completo de tudo e, em caso de erro, aponta exatamente onde falhou.

Só usa a biblioteca padrão do Python 3 (>=3.8) — nada de pip. Pensado para `python3 provision_ubuntu.py`.

Exemplos:
  sudo python3 deploy/provision_ubuntu.py                       # privado (login exigido, loopback/LAN)
  sudo python3 deploy/provision_ubuntu.py --exposure public \\
       --public-url https://paperclip.exemplo.com               # internet-facing (atrás de proxy reverso + TLS)
  python3 deploy/provision_ubuntu.py --dry-run                  # mostra o que faria, sem executar
"""

from __future__ import annotations

import argparse
import base64
import datetime as _dt
import os
import platform
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# --------------------------------------------------------------------------- #
# Apresentação / logging
# --------------------------------------------------------------------------- #

_USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _USE_COLOR else text


def green(t: str) -> str:  return _c("32", t)
def red(t: str) -> str:    return _c("31", t)
def yellow(t: str) -> str: return _c("33", t)
def cyan(t: str) -> str:   return _c("36", t)
def bold(t: str) -> str:   return _c("1", t)


class Logger:
    """Escreve em arquivo (sempre) e no console (com cor)."""

    def __init__(self, log_path: Path):
        self.log_path = log_path
        log_path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = log_path.open("a", encoding="utf-8")
        self.line(f"=== provision_ubuntu.py iniciado {_dt.datetime.now().isoformat()} ===")

    def _write(self, text: str) -> None:
        self._fh.write(text + "\n")
        self._fh.flush()

    def line(self, text: str) -> None:
        self._write(text)

    def info(self, text: str) -> None:
        print(text)
        self._write(text)

    def ok(self, text: str) -> None:
        print(green("  ✓ ") + text)
        self._write("  [OK] " + text)

    def warn(self, text: str) -> None:
        print(yellow("  ! ") + text)
        self._write("  [WARN] " + text)

    def err(self, text: str) -> None:
        print(red("  ✗ ") + text, file=sys.stderr)
        self._write("  [ERR] " + text)

    def close(self) -> None:
        self._write(f"=== fim {_dt.datetime.now().isoformat()} ===")
        self._fh.close()


class StepRunner:
    """Numera as etapas e mostra progresso [n/total]."""

    def __init__(self, log: Logger, total: int):
        self.log = log
        self.total = total
        self.n = 0

    def step(self, title: str) -> None:
        self.n += 1
        header = f"[{self.n}/{self.total}] {title}"
        print()
        print(bold(cyan("▶ " + header)))
        self.log.line("\n>>> " + header)


class ProvisionError(Exception):
    """Erro de provisionamento com contexto já logado."""


# --------------------------------------------------------------------------- #
# Execução de comandos
# --------------------------------------------------------------------------- #

class Ctx:
    def __init__(self, log: Logger, dry_run: bool, use_sudo: bool):
        self.log = log
        self.dry_run = dry_run
        self.use_sudo = use_sudo


def run(ctx: Ctx, cmd: list[str], *, sudo: bool = False, check: bool = True,
        capture: bool = True, env: dict | None = None, cwd: Path | None = None,
        stream: bool = False) -> subprocess.CompletedProcess:
    """Roda um comando, registrando-o no log. `stream=True` mostra a saída ao vivo
    (para builds longos); senão captura e só mostra em caso de erro."""
    full = (["sudo"] if (sudo and ctx.use_sudo) else []) + cmd
    printable = " ".join(full)
    ctx.log.line("$ " + printable)
    if ctx.dry_run:
        ctx.log.line("(dry-run: não executado)")
        return subprocess.CompletedProcess(full, 0, "", "")

    merged_env = {**os.environ, **(env or {})}
    if stream:
        # Streama linha a linha para console e log.
        proc = subprocess.Popen(full, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, env=merged_env, cwd=str(cwd) if cwd else None)
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.rstrip("\n")
            print("    " + line)
            ctx.log.line("    " + line)
        rc = proc.wait()
        result = subprocess.CompletedProcess(full, rc, "", "")
    else:
        result = subprocess.run(full, capture_output=capture, text=True,
                                env=merged_env, cwd=str(cwd) if cwd else None)
        if result.stdout:
            ctx.log.line(result.stdout.rstrip())
        if result.stderr:
            ctx.log.line(result.stderr.rstrip())

    if check and result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip().splitlines()[-15:]
        ctx.log.err(f"comando falhou (rc={result.returncode}): {printable}")
        for ln in tail:
            ctx.log.err("    " + ln)
        raise ProvisionError(f"comando falhou: {printable}")
    return result


def have(cmd: str) -> bool:
    return shutil.which(cmd) is not None


# --------------------------------------------------------------------------- #
# Geração de segredos / .env
# --------------------------------------------------------------------------- #

def gen_key_b64(num_bytes: int = 32) -> str:
    """Chave aleatória em base64 (32 bytes => chave AES-256 / segredo forte)."""
    return base64.b64encode(secrets.token_bytes(num_bytes)).decode("ascii")


def gen_url_safe(num_bytes: int = 24) -> str:
    """Segredo aleatório só com [0-9a-f] — seguro dentro de uma URL (ex.: a senha
    do Postgres entra na DATABASE_URL `postgres://user:SENHA@host`; base64 traz
    `/` e `+` que quebram o parsing da URL)."""
    return secrets.token_hex(num_bytes)


def parse_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def render_env_file(values: dict[str, str]) -> str:
    header = (
        "# Gerado por deploy/provision_ubuntu.py — NÃO comitar (contém segredos).\n"
        "# Segredos existentes são preservados em re-execuções.\n"
    )
    lines = [header]
    for k, v in values.items():
        lines.append(f"{k}={v}")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# Etapas
# --------------------------------------------------------------------------- #

APT_PACKAGES = ["ca-certificates", "curl", "git", "openssl", "gnupg"]


def check_platform(ctx: Ctx) -> None:
    if platform.system() != "Linux":
        raise ProvisionError("Este script é para Linux/Ubuntu.")
    os_release = Path("/etc/os-release")
    distro = ""
    if os_release.exists():
        distro = os_release.read_text(encoding="utf-8")
    if "ID=ubuntu" not in distro and "ID=debian" not in distro and "ID_LIKE=debian" not in distro:
        ctx.log.warn("Distro não parece Ubuntu/Debian; instalação de pacotes via apt pode não funcionar.")
    else:
        ctx.log.ok("Ubuntu/Debian detectado.")
    if sys.version_info < (3, 8):
        raise ProvisionError(f"Python 3.8+ necessário (atual: {platform.python_version()}).")
    ctx.log.ok(f"Python {platform.python_version()}.")


def ensure_sudo(ctx: Ctx, install_system: bool) -> None:
    if not install_system:
        return
    is_root = (os.geteuid() == 0)
    if is_root:
        ctx.use_sudo = False
        ctx.log.ok("Rodando como root.")
        return
    if not have("sudo"):
        raise ProvisionError("Sem root e sem 'sudo'. Rode como root ou instale sudo.")
    # Verifica se o sudo está disponível sem senha; senão avisa que pode pedir senha.
    probe = subprocess.run(["sudo", "-n", "true"], capture_output=True, text=True)
    if probe.returncode != 0:
        ctx.log.warn("sudo pode pedir senha durante a instalação de pacotes.")
    ctx.use_sudo = True


def ensure_apt_packages(ctx: Ctx) -> None:
    if not have("apt-get"):
        ctx.log.warn("apt-get ausente; pulando instalação de pacotes do sistema.")
        return
    missing = [p for p in APT_PACKAGES if not _pkg_installed(p)]
    if not missing:
        ctx.log.ok("Pacotes base já instalados (" + ", ".join(APT_PACKAGES) + ").")
        return
    ctx.log.info("  Instalando pacotes faltantes: " + ", ".join(missing))
    run(ctx, ["apt-get", "update", "-y"], sudo=True)
    run(ctx, ["apt-get", "install", "-y", *missing], sudo=True)
    ctx.log.ok("Pacotes base instalados.")


def _pkg_installed(pkg: str) -> bool:
    # Heurística: ferramenta no PATH OU dpkg reporta instalado.
    binary = {"ca-certificates": None, "gnupg": "gpg"}.get(pkg, pkg)
    if binary and have(binary):
        return True
    r = subprocess.run(["dpkg", "-s", pkg], capture_output=True, text=True)
    return r.returncode == 0


def ensure_docker(ctx: Ctx, install_system: bool) -> list[str]:
    """Garante Docker Engine + compose v2. Retorna o comando-base do compose."""
    docker_ok = have("docker")
    compose_v2 = docker_ok and subprocess.run(
        ["docker", "compose", "version"], capture_output=True, text=True
    ).returncode == 0

    if docker_ok and compose_v2:
        ctx.log.ok("Docker + compose v2 já instalados.")
    elif not install_system:
        raise ProvisionError("Docker/compose ausente e --no-system-install ativo. Instale o Docker manualmente.")
    else:
        ctx.log.info("  Instalando Docker Engine + plugin compose (repo oficial)…")
        _install_docker_apt(ctx)
        ctx.log.ok("Docker instalado.")

    # Habilita e inicia o serviço (se houver systemd).
    if have("systemctl") and install_system and not ctx.dry_run:
        run(ctx, ["systemctl", "enable", "--now", "docker"], sudo=True, check=False)

    # Adiciona o usuário ao grupo docker (efetivo após re-login).
    sudo_user = os.environ.get("SUDO_USER")
    if sudo_user and install_system:
        run(ctx, ["usermod", "-aG", "docker", sudo_user], sudo=True, check=False)
        ctx.log.warn(f"Usuário '{sudo_user}' adicionado ao grupo docker — faça logout/login para usar docker sem sudo.")

    # Decide se os comandos docker precisam de sudo nesta sessão.
    needs_sudo = not _docker_works_without_sudo(ctx)
    base = (["sudo"] if (needs_sudo and ctx.use_sudo) else []) + ["docker", "compose"]
    ctx.log.line("compose base: " + " ".join(base))
    return base


def _docker_works_without_sudo(ctx: Ctx) -> bool:
    if ctx.dry_run:
        return True
    return subprocess.run(["docker", "info"], capture_output=True, text=True).returncode == 0


def _install_docker_apt(ctx: Ctx) -> None:
    # Procedimento oficial do Docker para Debian/Ubuntu.
    run(ctx, ["install", "-m", "0755", "-d", "/etc/apt/keyrings"], sudo=True)
    keyring = "/etc/apt/keyrings/docker.asc"
    # Detecta ubuntu vs debian para a URL do GPG/repo.
    distro_id = "ubuntu"
    osr = Path("/etc/os-release")
    if osr.exists() and "ID=debian" in osr.read_text(encoding="utf-8"):
        distro_id = "debian"
    run(ctx, ["curl", "-fsSL", f"https://download.docker.com/linux/{distro_id}/gpg", "-o", keyring], sudo=True)
    run(ctx, ["chmod", "a+r", keyring], sudo=True)

    arch = subprocess.run(["dpkg", "--print-architecture"], capture_output=True, text=True).stdout.strip() or "amd64"
    codename = _os_codename()
    repo_line = (
        f"deb [arch={arch} signed-by={keyring}] "
        f"https://download.docker.com/linux/{distro_id} {codename} stable\n"
    )
    list_path = Path("/etc/apt/sources.list.d/docker.list")
    if ctx.dry_run:
        ctx.log.line(f"(dry-run) escreveria {list_path}: {repo_line.strip()}")
    else:
        # Escreve via tee+sudo para respeitar permissões de root.
        run(ctx, ["bash", "-c", f"echo '{repo_line.strip()}' > {list_path}"], sudo=True)
    run(ctx, ["apt-get", "update", "-y"], sudo=True)
    run(ctx, ["apt-get", "install", "-y", "docker-ce", "docker-ce-cli", "containerd.io",
              "docker-buildx-plugin", "docker-compose-plugin"], sudo=True)


def _os_codename() -> str:
    osr = Path("/etc/os-release")
    if osr.exists():
        for line in osr.read_text(encoding="utf-8").splitlines():
            if line.startswith("VERSION_CODENAME="):
                return line.split("=", 1)[1].strip().strip('"')
    # fallback
    r = subprocess.run(["bash", "-c", ". /etc/os-release && echo $VERSION_CODENAME"],
                       capture_output=True, text=True)
    return (r.stdout.strip() or "noble")


def write_env_and_override(ctx: Ctx, repo: Path, args) -> Path:
    """Gera docker/.env (idempotente) e o override docker/docker-compose.deploy.yml."""
    docker_dir = repo / "docker"
    env_path = docker_dir / ".env"
    existing = parse_env_file(env_path)

    def keep_or(key: str, factory) -> str:
        # Preserva segredo/valor já presente; senão gera/define.
        if existing.get(key):
            return existing[key]
        return factory()

    public_url = args.public_url or f"http://localhost:{args.port}"

    values: dict[str, str] = {
        # --- Postgres ---
        "POSTGRES_USER": existing.get("POSTGRES_USER", "paperclip"),
        "POSTGRES_DB": existing.get("POSTGRES_DB", "paperclip"),
        # URL-safe: vai dentro da DATABASE_URL (postgres://user:SENHA@host).
        "POSTGRES_PASSWORD": keep_or("POSTGRES_PASSWORD", lambda: gen_url_safe(24)),
        # --- App / auth ---
        "PAPERCLIP_PUBLIC_URL": existing.get("PAPERCLIP_PUBLIC_URL", public_url),
        "BETTER_AUTH_SECRET": keep_or("BETTER_AUTH_SECRET", lambda: gen_key_b64(48)),
        "PAPERCLIP_DEPLOYMENT_MODE": "authenticated",
        "PAPERCLIP_DEPLOYMENT_EXPOSURE": args.exposure,
        # Banco novo numa primeira subida: aplica migrations automaticamente.
        "PAPERCLIP_MIGRATION_AUTO_APPLY": "true",
        # --- Segredos em repouso ---
        # Pin do master key (consistência de backups; mantenha fora de backups).
        "PAPERCLIP_SECRETS_MASTER_KEY": keep_or("PAPERCLIP_SECRETS_MASTER_KEY", lambda: gen_key_b64(32)),
        # --- Hardening (defesas implementadas) ---
        "PAPERCLIP_SOFT_DELETE_GRACE_DAYS": existing.get("PAPERCLIP_SOFT_DELETE_GRACE_DAYS", "30"),
    }

    if args.backup_encryption:
        values["PAPERCLIP_DB_BACKUP_ENCRYPTED"] = "true"
        values["PAPERCLIP_DB_BACKUP_KEY"] = keep_or("PAPERCLIP_DB_BACKUP_KEY", lambda: gen_key_b64(32))

    if args.exposure == "public":
        # Atrás de proxy reverso: req.ip correto + rate limiting por cliente.
        values["TRUST_PROXY"] = existing.get("TRUST_PROXY", "1")

    # Preserva quaisquer chaves extras que o operador já tinha adicionado.
    for k, v in existing.items():
        values.setdefault(k, v)

    newly_generated = [k for k in ("POSTGRES_PASSWORD", "BETTER_AUTH_SECRET",
                                   "PAPERCLIP_SECRETS_MASTER_KEY", "PAPERCLIP_DB_BACKUP_KEY")
                       if k in values and not existing.get(k)]

    if ctx.dry_run:
        ctx.log.info(f"  (dry-run) escreveria {env_path} com chaves: {', '.join(values)}")
    else:
        env_path.write_text(render_env_file(values), encoding="utf-8")
        os.chmod(env_path, 0o600)
        ctx.log.ok(f"Escrito {env_path} (chmod 600).")
        if newly_generated:
            ctx.log.info("  Segredos gerados: " + ", ".join(newly_generated))
        if existing:
            ctx.log.info("  Segredos pré-existentes preservados.")

    # Override compose: injeta TODO o .env no container + controla exposure/migrate.
    override = (
        "# Gerado por provision_ubuntu.py — injeta docker/.env no container do servidor\n"
        "# e permite controlar exposure/migrations pelo .env.\n"
        "services:\n"
        "  server:\n"
        "    env_file:\n"
        "      - ./.env\n"
        "    environment:\n"
        '      PAPERCLIP_DEPLOYMENT_EXPOSURE: "${PAPERCLIP_DEPLOYMENT_EXPOSURE:-private}"\n'
        '      PAPERCLIP_MIGRATION_AUTO_APPLY: "${PAPERCLIP_MIGRATION_AUTO_APPLY:-true}"\n'
    )
    override_path = docker_dir / "docker-compose.deploy.yml"
    if ctx.dry_run:
        ctx.log.info(f"  (dry-run) escreveria {override_path}")
    else:
        override_path.write_text(override, encoding="utf-8")
        ctx.log.ok(f"Escrito {override_path}.")
    return env_path


def compose_up(ctx: Ctx, repo: Path, compose_base: list[str], args) -> None:
    files = ["-f", "docker/docker-compose.yml", "-f", "docker/docker-compose.deploy.yml"]
    cmd = compose_base + files + ["up", "-d", "--build"]
    if args.port != 3100:
        ctx.log.warn(f"Porta {args.port} solicitada; o compose publica 3100 por padrão. "
                     "Ajuste docker/docker-compose.yml (ports) se precisar de outra porta no host.")
    ctx.log.info("  Buildando e subindo containers (pode levar alguns minutos na 1ª vez)…")
    run(ctx, cmd, cwd=repo, stream=True, capture=False)
    ctx.log.ok("Containers no ar.")


def wait_for_health(ctx: Ctx, args) -> bool:
    if ctx.dry_run:
        return True
    url = f"http://127.0.0.1:{args.port}/health"
    ctx.log.info(f"  Aguardando {url} (timeout {args.health_timeout}s)…")
    deadline = time.time() + args.health_timeout
    last_err = ""
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                if 200 <= resp.status < 500:
                    ctx.log.ok(f"/health respondeu HTTP {resp.status}.")
                    return True
        except urllib.error.HTTPError as e:
            if 200 <= e.code < 500:
                ctx.log.ok(f"/health respondeu HTTP {e.code}.")
                return True
            last_err = f"HTTP {e.code}"
        except Exception as e:  # conexão recusada enquanto sobe
            last_err = str(e)
        time.sleep(3)
    ctx.log.warn(f"/health não respondeu a tempo (último erro: {last_err}).")
    return False


def print_summary(ctx: Ctx, repo: Path, compose_base: list[str], args, healthy: bool) -> None:
    cb = " ".join(compose_base)
    print()
    print(bold(green("══════════════════════════════════════════════════════════════")))
    print(bold(green(" Paperclip provisionado")))
    print(bold(green("══════════════════════════════════════════════════════════════")))
    url = args.public_url or f"http://<IP-do-host>:{args.port}"
    print(f"  URL:        {cyan(url)}")
    print(f"  Modo:       authenticated / {args.exposure}")
    print(f"  Log:        {ctx.log.log_path}")
    print(f"  Segredos:   {repo/'docker'/'.env'}  (chmod 600 — não comitar)")
    print()
    print(bold("  Comandos úteis:"))
    print(f"    Logs ao vivo:   {cb} -f docker/docker-compose.yml -f docker/docker-compose.deploy.yml logs -f")
    print(f"    Status:         {cb} -f docker/docker-compose.yml -f docker/docker-compose.deploy.yml ps")
    print(f"    Parar:          {cb} -f docker/docker-compose.yml -f docker/docker-compose.deploy.yml down")
    print()
    if not healthy:
        print(yellow("  ! O /health ainda não respondeu. Veja os logs com o comando acima."))
    if args.exposure == "public":
        print(yellow("  ! Exposição PÚBLICA: coloque um proxy reverso com TLS na frente da porta 3100,"))
        print(yellow("    e se usar cloud-tenant defina PAPERCLIP_CLOUD_TENANT_HMAC_KEY (veja UBUNTU_DEPLOY.md)."))
    print(f"  Primeiro acesso e claim do board: veja {repo/'deploy'/'UBUNTU_DEPLOY.md'}.")
    print()


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Provisiona o Paperclip num Ubuntu do zero (Docker).")
    p.add_argument("--repo-dir", type=Path, default=None,
                   help="Raiz do repositório Paperclip (default: detecta a partir deste script).")
    p.add_argument("--exposure", choices=["private", "public"], default="private",
                   help="private = login + rede confiável (default); public = internet-facing.")
    p.add_argument("--public-url", default=None,
                   help="URL pública (obrigatório em --exposure public, ex.: https://paperclip.exemplo.com).")
    p.add_argument("--port", type=int, default=3100, help="Porta HTTP no host (default 3100).")
    p.add_argument("--no-system-install", action="store_true",
                   help="Não instala pacotes/Docker via apt (exige Docker já presente).")
    p.add_argument("--no-backup-encryption", dest="backup_encryption", action="store_false",
                   help="Não habilita criptografia de backups (habilitada por padrão).")
    p.add_argument("--health-timeout", type=int, default=180, help="Segundos esperando o /health (default 180).")
    p.add_argument("--dry-run", action="store_true", help="Mostra o que faria, sem executar.")
    p.set_defaults(backup_encryption=True)
    return p.parse_args(argv)


def resolve_repo(args) -> Path:
    if args.repo_dir:
        repo = args.repo_dir.resolve()
    else:
        # Este script vive em <repo>/deploy/provision_ubuntu.py
        repo = Path(__file__).resolve().parent.parent
    if not (repo / "docker" / "docker-compose.yml").exists():
        raise ProvisionError(
            f"Não encontrei docker/docker-compose.yml em {repo}. "
            "Rode dentro do repositório ou passe --repo-dir."
        )
    return repo


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    timestamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")

    # Resolve repo cedo para posicionar o log dentro dele.
    try:
        repo = resolve_repo(args)
    except ProvisionError as e:
        print(red("✗ ") + str(e), file=sys.stderr)
        return 2

    log_path = repo / "deploy" / "logs" / f"provision-{timestamp}.log"
    log = Logger(log_path)
    ctx = Ctx(log, dry_run=args.dry_run, use_sudo=False)

    if args.exposure == "public" and not args.public_url:
        log.err("--exposure public exige --public-url (ex.: https://paperclip.exemplo.com).")
        log.close()
        return 2

    install_system = not args.no_system_install
    steps = StepRunner(log, total=7)

    try:
        steps.step("Verificando plataforma e pré-requisitos")
        check_platform(ctx)
        ensure_sudo(ctx, install_system)

        steps.step("Instalando pacotes de sistema que faltarem")
        if install_system:
            ensure_apt_packages(ctx)
        else:
            log.warn("--no-system-install: pulando apt.")

        steps.step("Garantindo Docker Engine + Compose")
        compose_base = ensure_docker(ctx, install_system)

        steps.step("Gerando segredos e configuração (docker/.env)")
        write_env_and_override(ctx, repo, args)

        steps.step("Buildando e subindo os containers")
        compose_up(ctx, repo, compose_base, args)

        steps.step("Aguardando o servidor ficar saudável (/health)")
        healthy = wait_for_health(ctx, args)

        steps.step("Resumo")
        print_summary(ctx, repo, compose_base, args, healthy)

        log.info(green("\nConcluído.") if healthy else yellow("\nConcluído com avisos (veja acima)."))
        log.close()
        return 0 if healthy else 1

    except ProvisionError as e:
        print()
        log.err(str(e))
        log.err(f"Provisionamento abortado. Log completo: {log_path}")
        print(red(f"\n✗ Falhou. Veja o log: {log_path}"), file=sys.stderr)
        log.close()
        return 1
    except KeyboardInterrupt:
        log.err("Interrompido pelo usuário.")
        log.close()
        return 130
    except Exception as e:  # noqa: BLE001 — captura ampla para sempre logar
        log.err(f"Erro inesperado: {e!r}")
        log.err(f"Log completo: {log_path}")
        print(red(f"\n✗ Erro inesperado. Log: {log_path}"), file=sys.stderr)
        log.close()
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
