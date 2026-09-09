#!/usr/bin/env bash
# Server-side deploy: Node app + Python V4.1 engine
# Usage: bash remote-deploy.sh /tmp/whale-deploy-pack
set -euo pipefail

PACK="${1:-/tmp/whale-deploy-pack}"
DEPLOY="${DEPLOY:-/root/whale-tracker-deploy}"
ENGINE="${ENGINE:-/root/ai-trading-system-v41}"

echo "==> PATH=$PATH"
echo -n "==> node: "; command -v node || true
echo -n "==> npm: "; command -v npm || true
echo -n "==> python3: "; command -v python3 || true

command -v npm >/dev/null 2>&1 || { echo "ERROR: npm not found"; exit 127; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 not found"; exit 127; }

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

echo "==> ensure pip"
if ! "$PY" -m pip --version >/dev/null 2>&1; then
  echo "==> pip missing, bootstrapping"
  "$PY" -m ensurepip --upgrade >/tmp/ensurepip.log 2>&1 || true
  if ! "$PY" -m pip --version >/dev/null 2>&1; then
    if command -v dnf >/dev/null 2>&1; then
      dnf install -y python3-pip >/tmp/dnf-pip.log 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
      yum install -y python3-pip >/tmp/yum-pip.log 2>&1 || true
    elif command -v apt-get >/dev/null 2>&1; then
      apt-get update -y >/tmp/apt-update.log 2>&1 || true
      apt-get install -y python3-pip >/tmp/apt-pip.log 2>&1 || true
    fi
  fi
  if ! "$PY" -m pip --version >/dev/null 2>&1; then
    echo "==> using get-pip.py"
    curl -fsSL https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py
    # PEP 668 distros may need --break-system-packages
    if ! "$PY" /tmp/get-pip.py; then
      "$PY" /tmp/get-pip.py --break-system-packages
    fi
  fi
fi

if ! "$PY" -m pip --version; then
  echo "ERROR: pip still unavailable"
  tail -n 50 /tmp/ensurepip.log /tmp/dnf-pip.log /tmp/yum-pip.log /tmp/apt-pip.log 2>/dev/null || true
  exit 11
fi

echo "==> pip install requirements"
"$PY" -m pip install -U pip setuptools wheel || \
  "$PY" -m pip install -U pip setuptools wheel --break-system-packages || true
if ! "$PY" -m pip install -r requirements.txt; then
  echo "==> retry with --break-system-packages"
  "$PY" -m pip install -r requirements.txt --break-system-packages
fi

PY_BIN=$(readlink -f "$PY" 2>/dev/null || echo "$PY")
echo "==> write v41-engine.service (ExecStart=$PY_BIN)"
cat > /etc/systemd/system/v41-engine.service <<EOF
[Unit]
Description=V4.1 Trading Engine
After=network.target

[Service]
Type=simple
WorkingDirectory=${ENGINE}
ExecStart=${PY_BIN} scripts/run_engine_api.py
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
