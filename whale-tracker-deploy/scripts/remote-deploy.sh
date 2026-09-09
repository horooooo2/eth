#!/usr/bin/env bash
# Server-side deploy: Python engine first, then Node.
# Usage: bash remote-deploy.sh /tmp/whale-deploy-pack
set -euo pipefail

PACK="${1:-/tmp/whale-deploy-pack}"
DEPLOY="${DEPLOY:-/root/whale-tracker-deploy}"
ENGINE="${ENGINE:-/root/ai-trading-system-v41}"

export PATH="/usr/local/lighthouse/softwares/nodejs/node/bin:/root/.local/bin:/root/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin"

echo "==> PATH=$PATH"

if ! command -v node >/dev/null 2>&1; then echo "ERROR: node not found in PATH"; exit 41; fi
if ! command -v npm >/dev/null 2>&1; then echo "ERROR: npm not found in PATH"; exit 42; fi
if ! command -v python3 >/dev/null 2>&1; then echo "ERROR: python3 not found in PATH"; exit 43; fi
if ! command -v tar >/dev/null 2>&1; then echo "ERROR: tar not found in PATH"; exit 44; fi
if ! command -v curl >/dev/null 2>&1; then echo "ERROR: curl not found in PATH"; exit 45; fi
if ! command -v systemctl >/dev/null 2>&1; then echo "ERROR: systemctl not found in PATH"; exit 46; fi

echo "==> node: $(command -v node)"
echo "==> npm: $(command -v npm)"
echo "==> python3: $(command -v python3)"

mkdir -p "$DEPLOY" "$ENGINE" "$PACK"
test -f "$PACK/code.tgz" || { echo "ERROR: missing $PACK/code.tgz"; exit 2; }
test -f "$PACK/public.tgz" || { echo "ERROR: missing $PACK/public.tgz"; exit 2; }
test -f "$PACK/engine.tgz" || { echo "ERROR: missing $PACK/engine.tgz"; exit 2; }
test -s "$PACK/engine.tgz" || { echo "ERROR: empty engine.tgz"; exit 2; }

upsert_env() {
  local file="$1" key="$2" val="$3"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$file"
  else
    echo "${key}=${val}" >> "$file"
  fi
}

print_safe_env() {
  local file="$1" label="$2"
  echo "==> non-secret ENV ($label)"
  if [ ! -f "$file" ]; then
    echo "(missing $file)"
    return 0
  fi
  grep -E '^(V41_ALPHA_EXECUTION|V41_ENGINE_EXECUTION_MODE|V41_LIVE_TRADING_ENABLED|V41_QA_LIVE_ENABLED|V41_MARKET_DATA_SOURCE|V41_ENGINE_AUTOSTART|V41_ENGINE_HOST|V41_ENGINE_PORT|V41_ENGINE_ENABLED|V41_HFT_SIM_ENABLED|V41_QA_EXCHANGE_ENABLED)=' "$file" | sed 's/\r$//' || true
}

abort_if_live_trading() {
  local file="$1"
  [ -f "$file" ] || return 0
  if grep -qiE '^V41_LIVE_TRADING_ENABLED=(true|1|yes|on)' "$file"; then
    echo "ERROR: $file has V41_LIVE_TRADING_ENABLED=true — abort deploy"
    exit 51
  fi
}

print_safe_env "$ENGINE/.env" "current engine"
print_safe_env "$DEPLOY/.env" "current node"
abort_if_live_trading "$ENGINE/.env"
abort_if_live_trading "$DEPLOY/.env"

NODE_TOKEN=""
if [ -f "$DEPLOY/.env" ] && grep -q '^V41_ENGINE_INTERNAL_TOKEN=' "$DEPLOY/.env"; then
  NODE_TOKEN=$(grep '^V41_ENGINE_INTERNAL_TOKEN=' "$DEPLOY/.env" | head -1 | cut -d= -f2- | tr -d '\r')
elif [ -f "$ENGINE/.env" ] && grep -q '^V41_ENGINE_INTERNAL_TOKEN=' "$ENGINE/.env"; then
  NODE_TOKEN=$(grep '^V41_ENGINE_INTERNAL_TOKEN=' "$ENGINE/.env" | head -1 | cut -d= -f2- | tr -d '\r')
fi
NODE_TOKEN=${NODE_TOKEN:-dev-internal-token}
echo "==> engine token length=${#NODE_TOKEN}"

echo "==> extract Python engine"
tar -C "$ENGINE" -xzf "$PACK/engine.tgz"
test -f "$ENGINE/scripts/run_engine_api.py" || { echo "ERROR: run_engine_api.py missing after extract"; exit 10; }
test -f "$ENGINE/requirements.txt" || { echo "ERROR: requirements.txt missing after extract"; exit 10; }

if [ ! -f "$ENGINE/.env" ]; then
  cat > "$ENGINE/.env" <<EOF
V41_ENGINE_INTERNAL_TOKEN=${NODE_TOKEN}
V41_ENGINE_AUTOSTART=0
V41_ENGINE_HOST=127.0.0.1
V41_ENGINE_PORT=8711
V41_ALPHA_EXECUTION=EXECUTE
V41_ENGINE_EXECUTION_MODE=node_gateway
V41_LIVE_TRADING_ENABLED=false
V41_MARKET_DATA_SOURCE=okx
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
  upsert_env "$ENGINE/.env" V41_ENGINE_AUTOSTART 0
  upsert_env "$ENGINE/.env" V41_HFT_SIM_ENABLED true
  upsert_env "$ENGINE/.env" V41_QA_EXCHANGE_ENABLED true
  upsert_env "$ENGINE/.env" V41_QA_LIVE_ENABLED false
  upsert_env "$ENGINE/.env" V41_ALPHA_EXECUTION EXECUTE
  upsert_env "$ENGINE/.env" V41_LIVE_TRADING_ENABLED false
  upsert_env "$ENGINE/.env" V41_ENGINE_EXECUTION_MODE node_gateway
  upsert_env "$ENGINE/.env" V41_MARKET_DATA_SOURCE okx
  if grep -qE '^OKX_API_(KEY|SECRET|PASSPHRASE)=' "$ENGINE/.env"; then
    echo "==> strip global OKX_API_* from engine .env"
    sed -i -E 's/^OKX_API_KEY=.*/# OKX_API_KEY= (removed: Node uses per-user keys)/' "$ENGINE/.env"
    sed -i -E 's/^OKX_API_SECRET=.*/# OKX_API_SECRET= (removed)/' "$ENGINE/.env"
    sed -i -E 's/^OKX_API_PASSPHRASE=.*/# OKX_API_PASSPHRASE= (removed)/' "$ENGINE/.env"
  fi
fi

print_safe_env "$ENGINE/.env" "engine after upsert"
abort_if_live_trading "$ENGINE/.env"

PY=$(command -v python3)
cd "$ENGINE"

echo "==> create/reuse venv (no system pip / no --break-system-packages)"
VENV="$ENGINE/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "==> python3 -m venv $VENV"
  if ! "$PY" -m venv "$VENV"; then
    "$PY" -m ensurepip --upgrade >/tmp/ensurepip.log 2>&1 || true
    if command -v dnf >/dev/null 2>&1; then
      dnf install -y python3-pip python3-venv >/tmp/dnf-venv.log 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
      yum install -y python3-pip python3-venv >/tmp/yum-venv.log 2>&1 || true
    fi
    "$PY" -m venv "$VENV" || { echo "ERROR: failed to create venv"; exit 12; }
  fi
fi

VENV_PY="$VENV/bin/python"
test -x "$VENV_PY" || { echo "ERROR: missing $VENV_PY"; exit 12; }
echo "==> venv python: $VENV_PY"
"$VENV_PY" -m pip install -U pip setuptools wheel
echo "==> pip install requirements into venv"
"$VENV_PY" -m pip install -r requirements.txt
echo "==> verify venv imports"
"$VENV_PY" -c "import fastapi, uvicorn, ccxt, pandas; print('deps ok')"

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

echo "==> wait for Python 8711 health (Node not restarted yet)"
py_ok=0
for i in $(seq 1 20); do
  sleep 2
  if ss -lntp 2>/dev/null | grep -q ':8711'; then
    echo "8711 LISTEN (attempt $i)"
  fi
  if curl -sf --max-time 3 -H "X-Engine-Token: ${NODE_TOKEN}" http://127.0.0.1:8711/internal/v1/health >/dev/null; then
    echo "Python health 200 (attempt $i)"
    py_ok=1
    break
  fi
  echo "engine health not ready, attempt $i"
done

if [ "$py_ok" != "1" ]; then
  echo "ERROR: Python 8711 health failed — abort Node deploy"
  systemctl --no-pager --full status v41-engine || true
  journalctl -u v41-engine -n 80 --no-pager || true
  exit 7
fi

echo "==> extract Node backend (Python already healthy)"
tar -C "$DEPLOY" -xzf "$PACK/code.tgz"
mkdir -p "$DEPLOY/public"
rm -rf "$DEPLOY/public/assets"
tar -C "$DEPLOY/public" -xzf "$PACK/public.tgz"

echo "==> npm install"
cd "$DEPLOY"
npm install --omit=dev

touch "$DEPLOY/.env"
if [ -f "$DEPLOY/.env" ] && grep -qE '^OKX_API_(KEY|SECRET|PASSPHRASE)=' "$DEPLOY/.env"; then
  echo "==> strip global OKX_API_* from $DEPLOY/.env (per-user keys only)"
  sed -i -E 's/^OKX_API_KEY=.*/# OKX_API_KEY= (removed: use per-user binding)/' "$DEPLOY/.env"
  sed -i -E 's/^OKX_API_SECRET=.*/# OKX_API_SECRET= (removed: use per-user binding)/' "$DEPLOY/.env"
  sed -i -E 's/^OKX_API_PASSPHRASE=.*/# OKX_API_PASSPHRASE= (removed: use per-user binding)/' "$DEPLOY/.env"
  grep -q '^OKX_ALLOW_ENV_CREDS=' "$DEPLOY/.env" && sed -i -E 's/^OKX_ALLOW_ENV_CREDS=.*/OKX_ALLOW_ENV_CREDS=0/' "$DEPLOY/.env"
fi

grep -q '^V41_ENGINE_ENABLED=' "$DEPLOY/.env" || echo 'V41_ENGINE_ENABLED=true' >> "$DEPLOY/.env"
grep -q '^V41_ENGINE_BASE_URL=' "$DEPLOY/.env" || echo 'V41_ENGINE_BASE_URL=http://127.0.0.1:8711' >> "$DEPLOY/.env"
if ! grep -q '^V41_ENGINE_INTERNAL_TOKEN=' "$DEPLOY/.env"; then
  echo "V41_ENGINE_INTERNAL_TOKEN=${NODE_TOKEN}" >> "$DEPLOY/.env"
fi
upsert_env "$DEPLOY/.env" V41_HFT_SIM_ENABLED true
upsert_env "$DEPLOY/.env" V41_QA_EXCHANGE_ENABLED true
upsert_env "$DEPLOY/.env" V41_QA_LIVE_ENABLED false
upsert_env "$DEPLOY/.env" V41_LIVE_TRADING_ENABLED false
upsert_env "$DEPLOY/.env" V41_ALPHA_EXECUTION EXECUTE
upsert_env "$DEPLOY/.env" V41_ENGINE_EXECUTION_MODE node_gateway
upsert_env "$DEPLOY/.env" V41_MARKET_DATA_SOURCE okx
upsert_env "$DEPLOY/.env" V41_ENGINE_AUTOSTART 0
print_safe_env "$DEPLOY/.env" "node after upsert"
abort_if_live_trading "$DEPLOY/.env"

test -f "$DEPLOY/lib/v41UserBinding.js" || { echo "ERROR: missing v41UserBinding.js"; exit 9; }
test -f "$DEPLOY/lib/v41QaExchange.js" || { echo "ERROR: missing v41QaExchange.js"; exit 9; }

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

echo "==> Node + proxy health"
ok=0
for i in $(seq 1 15); do
  sleep 2
  if ! curl -sf --max-time 3 http://127.0.0.1/api/health >/dev/null; then
    echo "node health not ready, attempt $i"
    continue
  fi
  if ! curl -sf --max-time 3 -H "X-Engine-Token: ${NODE_TOKEN}" http://127.0.0.1:8711/internal/v1/health >/dev/null; then
    echo "engine health lost after node restart, attempt $i"
    continue
  fi
  echo "deploy ok (attempt $i) — node + engine"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1/api/whale-ai/trade/status || true)
  echo "whale-ai trade/status => HTTP $code"
  if [ "$code" = "404" ]; then
    echo "ERROR: whale-ai trade route 404"
    exit 8
  fi
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
