#!/usr/bin/env bash
# Server-side deploy: Node app + Python V4.1 engine
# Usage: bash remote-deploy.sh /tmp/whale-deploy-pack
set -euo pipefail

PACK="${1:-/tmp/whale-deploy-pack}"
DEPLOY="${DEPLOY:-/root/whale-tracker-deploy}"
ENGINE="${ENGINE:-/root/ai-trading-system-v41}"

# Do NOT source /etc/profile or bashrc here — under set -e / CI SSH they can exit the shell.
export PATH="/usr/local/lighthouse/softwares/nodejs/node/bin:/root/.local/bin:/root/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin"

echo "==> PATH=$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found in PATH"
  exit 41
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found in PATH"
  exit 42
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found in PATH"
  exit 43
fi
if ! command -v tar >/dev/null 2>&1; then
  echo "ERROR: tar not found in PATH"
  exit 44
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl not found in PATH"
  exit 45
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "ERROR: systemctl not found in PATH"
  exit 46
fi

echo "==> node: $(command -v node)"
echo "==> npm: $(command -v npm)"
echo "==> python3: $(command -v python3)"
echo "==> tar: $(command -v tar)"
echo "==> curl: $(command -v curl)"
echo "==> systemctl: $(command -v systemctl)"

mkdir -p "$DEPLOY" "$ENGINE" "$PACK"
test -f "$PACK/code.tgz" || { echo "ERROR: missing $PACK/code.tgz"; exit 2; }
test -f "$PACK/public.tgz" || { echo "ERROR: missing $PACK/public.tgz"; exit 2; }
test -f "$PACK/engine.tgz" || { echo "ERROR: missing $PACK/engine.tgz"; exit 2; }
test -s "$PACK/engine.tgz" || { echo "ERROR: empty engine.tgz"; exit 2; }

echo "==> extract Node backend"
tar -C "$DEPLOY" -xzf "$PACK/code.tgz"
mkdir -p "$DEPLOY/public"
rm -rf "$DEPLOY/public/assets"
tar -C "$DEPLOY/public" -xzf "$PACK/public.tgz"

echo "==> npm install"
cd "$DEPLOY"
npm install --omit=dev

touch "$DEPLOY/.env"
grep -q '^V41_ENGINE_ENABLED=' "$DEPLOY/.env" || echo 'V41_ENGINE_ENABLED=true' >> "$DEPLOY/.env"
grep -q '^V41_ENGINE_BASE_URL=' "$DEPLOY/.env" || echo 'V41_ENGINE_BASE_URL=http://127.0.0.1:8711' >> "$DEPLOY/.env"
if ! grep -q '^V41_ENGINE_INTERNAL_TOKEN=' "$DEPLOY/.env"; then
  echo 'V41_ENGINE_INTERNAL_TOKEN=dev-internal-token' >> "$DEPLOY/.env"
fi
NODE_TOKEN=$(grep '^V41_ENGINE_INTERNAL_TOKEN=' "$DEPLOY/.env" | head -1 | cut -d= -f2- | tr -d '\r')
NODE_TOKEN=${NODE_TOKEN:-dev-internal-token}
echo "==> engine token length=${#NODE_TOKEN}"

echo "==> restart whale-tracker"
if systemctl cat whale-tracker >/dev/null 2>&1; then
  systemctl restart whale-tracker
  systemctl --no-pager --full status whale-tracker || true
else
  if command -v fuser >/dev/null 2>&1; then
    fuser -k 80/tcp || true
  fi
  sleep 1
  nohup node server.js >/tmp/whale-tracker.log 2>&1 &
fi

echo "==> extract Python engine"
tar -C "$ENGINE" -xzf "$PACK/engine.tgz"
test -f "$ENGINE/scripts/run_engine_api.py" || { echo "ERROR: run_engine_api.py missing after extract"; exit 10; }
test -f "$ENGINE/requirements.txt" || { echo "ERROR: requirements.txt missing after extract"; exit 10; }

if [ ! -f "$ENGINE/.env" ]; then
  cat > "$ENGINE/.env" <<EOF
V41_ENGINE_INTERNAL_TOKEN=${NODE_TOKEN}
V41_ENGINE_AUTOSTART=1
V41_ENGINE_HOST=127.0.0.1
V41_ENGINE_PORT=8711
V41_ENGINE_EXECUTION_MODE=paper
V41_NODE_GATEWAY_URL=http://127.0.0.1:80
V41_HFT_SIM_ENABLED=true
V41_QA_EXCHANGE_ENABLED=true
V41_QA_LIVE_ENABLED=false
V41_WHALE_BRIDGE_ENABLED=false
EOF
  echo "==> created $ENGINE/.env"
else
  if grep -q '^V41_ENGINE_INTERNAL_TOKEN=' "$ENGINE/.env"; then
    sed -i "s|^V41_ENGINE_INTERNAL_TOKEN=.*|V41_ENGINE_INTERNAL_TOKEN=${NODE_TOKEN}|" "$ENGINE/.env"
  else
    echo "V41_ENGINE_INTERNAL_TOKEN=${NODE_TOKEN}" >> "$ENGINE/.env"
  fi
  grep -q '^V41_ENGINE_HOST=' "$ENGINE/.env" || echo 'V41_ENGINE_HOST=127.0.0.1' >> "$ENGINE/.env"
  grep -q '^V41_ENGINE_PORT=' "$ENGINE/.env" || echo 'V41_ENGINE_PORT=8711' >> "$ENGINE/.env"
  grep -q '^V41_NODE_GATEWAY_URL=' "$ENGINE/.env" || echo 'V41_NODE_GATEWAY_URL=http://127.0.0.1:80' >> "$ENGINE/.env"
  echo "==> updated existing $ENGINE/.env"
fi

PY=$(command -v python3)
cd "$ENGINE"

echo "==> create/reuse venv (avoid RPM idna/urllib3 uninstall conflicts)"
VENV="$ENGINE/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "==> python3 -m venv $VENV"
  if ! "$PY" -m venv "$VENV"; then
    echo "==> venv module missing - trying ensurepip / distro packages"
    "$PY" -m ensurepip --upgrade >/tmp/ensurepip.log 2>&1 || true
    if command -v dnf >/dev/null 2>&1; then
      dnf install -y python3-pip python3-venv >/tmp/dnf-venv.log 2>&1 || \
        dnf install -y python3-pip >/tmp/dnf-pip.log 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
      yum install -y python3-pip python3-venv >/tmp/yum-venv.log 2>&1 || true
    fi
    "$PY" -m venv "$VENV" || {
      echo "ERROR: failed to create venv"
      tail -n 40 /tmp/ensurepip.log /tmp/dnf-venv.log /tmp/dnf-pip.log /tmp/yum-venv.log 2>/dev/null || true
      exit 12
    }
  fi
fi

VENV_PY="$VENV/bin/python"
VENV_PIP="$VENV/bin/pip"
test -x "$VENV_PY" || { echo "ERROR: missing $VENV_PY"; exit 12; }

echo "==> venv python: $VENV_PY"
"$VENV_PY" -m pip install -U pip setuptools wheel
echo "==> pip install requirements into venv"
"$VENV_PY" -m pip install -r requirements.txt

echo "==> write v41-engine.service (ExecStart=$VENV_PY)"
cat > /etc/systemd/system/v41-engine.service <<EOF
[Unit]
Description=V4.1 Trading Engine
After=network.target

[Service]
Type=simple
WorkingDirectory=${ENGINE}
ExecStart=${VENV_PY} scripts/run_engine_api.py
Restart=always
RestartSec=3
EnvironmentFile=${ENGINE}/.env

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable v41-engine >/dev/null 2>&1 || true
systemctl restart v41-engine
sleep 2
systemctl --no-pager --full status v41-engine || true
journalctl -u v41-engine -n 40 --no-pager || true

echo "==> health checks"
ok=0
for i in $(seq 1 15); do
  sleep 2
  if ! curl -sf --max-time 3 http://127.0.0.1/api/health >/dev/null; then
    echo "node health not ready, attempt $i"
    continue
  fi
  if ! curl -sf --max-time 3 -H "X-Engine-Token: ${NODE_TOKEN}" http://127.0.0.1:8711/internal/v1/health >/dev/null; then
    echo "engine health not ready, attempt $i"
    continue
  fi
  echo
  echo "deploy ok (attempt $i) — node + engine"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1/api/whale-ai/trade/status || true)
  echo "whale-ai trade/status => HTTP $code"
  if [ "$code" = "404" ]; then
    echo "ERROR: whale-ai trade route 404"
    exit 8
  fi
  test -f "$DEPLOY/lib/v41QaExchange.js" || { echo "ERROR: missing v41QaExchange.js"; exit 9; }
  ok=1
  break
done

if [ "$ok" != "1" ]; then
  echo "health check failed"
  systemctl --no-pager --full status whale-tracker || true
  systemctl --no-pager --full status v41-engine || true
  journalctl -u whale-tracker -n 40 --no-pager || true
  journalctl -u v41-engine -n 80 --no-pager || true
  exit 7
fi

echo "==> deploy finished successfully"
