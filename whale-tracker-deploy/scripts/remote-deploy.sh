#!/usr/bin/env bash
# Server-side deploy: Node only. The Python trading engine has been removed.
# Usage: bash remote-deploy.sh /tmp/whale-deploy-pack
set -euo pipefail

PACK="${1:-/tmp/whale-deploy-pack}"
DEPLOY="${DEPLOY:-/root/whale-tracker-deploy}"

export PATH="/usr/local/lighthouse/softwares/nodejs/node/bin:/root/.local/bin:/root/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin"

echo "==> PATH=$PATH"

if ! command -v node >/dev/null 2>&1; then echo "ERROR: node not found in PATH"; exit 41; fi
if ! command -v npm >/dev/null 2>&1; then echo "ERROR: npm not found in PATH"; exit 42; fi
if ! command -v tar >/dev/null 2>&1; then echo "ERROR: tar not found in PATH"; exit 44; fi
if ! command -v curl >/dev/null 2>&1; then echo "ERROR: curl not found in PATH"; exit 45; fi
if ! command -v systemctl >/dev/null 2>&1; then echo "ERROR: systemctl not found in PATH"; exit 46; fi

echo "==> node: $(command -v node)"
echo "==> npm: $(command -v npm)"

mkdir -p "$DEPLOY" "$PACK"
test -f "$PACK/code.tgz" || { echo "ERROR: missing $PACK/code.tgz"; exit 2; }
test -f "$PACK/public.tgz" || { echo "ERROR: missing $PACK/public.tgz"; exit 2; }

# The strategy engine is gone. Stop and remove its unit so nothing keeps trading.
echo "==> retire v41-engine service (if present)"
systemctl stop v41-engine >/dev/null 2>&1 || true
systemctl disable v41-engine >/dev/null 2>&1 || true
rm -f /etc/systemd/system/v41-engine.service
systemctl daemon-reload
systemctl reset-failed v41-engine >/dev/null 2>&1 || true
if ss -lntp 2>/dev/null | grep -q ':8711'; then
  echo "ERROR: something still listens on 8711 after retiring v41-engine"
  ss -lntp | grep ':8711' || true
  exit 52
fi
echo "==> 8711 is free"

echo "==> extract Node backend"
tar -C "$DEPLOY" -xzf "$PACK/code.tgz"
mkdir -p "$DEPLOY/public"
rm -rf "$DEPLOY/public/assets"
tar -C "$DEPLOY/public" -xzf "$PACK/public.tgz"

# Drop static shims for pages that no longer exist
rm -f "$DEPLOY/public/strategy-config.html" "$DEPLOY/public/strategy-config.js"

echo "==> drop retired strategy modules from $DEPLOY"
rm -f "$DEPLOY"/lib/v41*.js \
      "$DEPLOY"/lib/s9Capabilities.js \
      "$DEPLOY"/lib/s9ReadinessOverlay.js \
      "$DEPLOY"/lib/okxTradeClient.js \
      "$DEPLOY"/lib/userExchangeKeys.js \
      "$DEPLOY"/lib/whaleAiRuntimeLogs.js \
      "$DEPLOY"/lib/strategyDisplayZh.js \
      "$DEPLOY"/lib/eventLogDisplay.js \
      "$DEPLOY"/routes/whaleAiEngine.js \
      "$DEPLOY"/routes/whaleAiTrade.js \
      "$DEPLOY"/routes/adminStrategyConfigs.js

echo "==> npm install"
cd "$DEPLOY"
npm install --omit=dev

touch "$DEPLOY/.env"

strip_env_key() {
  local file="$1" key="$2"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i "/^${key}=/d" "$file"
    echo "  removed ${key}"
  fi
}

# Strategy/exchange env is dead config now — remove it so nothing can re-enable trading.
echo "==> strip retired strategy/exchange ENV from $DEPLOY/.env"
for key in V41_ENGINE_ENABLED V41_ENGINE_BASE_URL V41_ENGINE_INTERNAL_TOKEN \
           V41_ENGINE_TIMEOUT_MS V41_ENGINE_HOST V41_ENGINE_PORT V41_ENGINE_AUTOSTART \
           V41_ENGINE_EXECUTION_MODE V41_ENGINE_OWNER_USER_ID V41_ENGINE_STALE_MS \
           V41_ENGINE_OFFLINE_MS V41_ALPHA_EXECUTION V41_LIVE_TRADING_ENABLED \
           V41_MARKET_DATA_SOURCE V41_NODE_GATEWAY_URL V41_HFT_SIM_ENABLED \
           V41_QA_EXCHANGE_ENABLED V41_QA_LIVE_ENABLED V41_WHALE_BRIDGE_ENABLED \
           V41_WHALE_BRIDGE_INTERVAL_MS V41_WHALE_BRIDGE_MODE V41_RESUME_ADMINS \
           OKX_API_KEY OKX_API_SECRET OKX_API_PASSPHRASE OKX_ALLOW_ENV_CREDS; do
  strip_env_key "$DEPLOY/.env" "$key"
done

echo "==> non-secret ENV (node)"
grep -E '^(PORT|SQLITE_PATH|FILL_BACKFILL|REFRESH_INTERVAL)=' "$DEPLOY/.env" | sed 's/\r$//' || true

echo "==> assert strategy modules are gone"
for dead in lib/v41EngineClient.js lib/v41ExecutionGateway.js lib/okxTradeClient.js \
            routes/whaleAiEngine.js routes/whaleAiTrade.js; do
  if [ -f "$DEPLOY/$dead" ]; then
    echo "ERROR: $dead still present in $DEPLOY"
    exit 9
  fi
done

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

echo "==> Node health + data routes"
ok=0
for i in $(seq 1 15); do
  sleep 2
  if ! curl -sf --max-time 3 http://127.0.0.1/api/health >/dev/null; then
    echo "node health not ready, attempt $i"
    continue
  fi
  echo "node health 200 (attempt $i)"
  for route in /api/whales /api/news /api/markets/quotes; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1${route}" || true)
    echo "  ${route} => HTTP $code"
    if [ "$code" = "404" ] || [ "$code" = "000" ]; then
      echo "ERROR: data route ${route} broken (HTTP $code)"
      exit 8
    fi
  done
  # Generic DeepSeek analysis must survive: unauthenticated call is 401, never 404.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1/api/whale-ai/key || true)
  echo "  /api/whale-ai/key => HTTP $code"
  if [ "$code" = "404" ]; then
    echo "ERROR: generic AI key route 404 — DeepSeek analysis was removed by mistake"
    exit 8
  fi
  # Strategy routes must be gone.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1/api/whale-ai/trade/status || true)
  echo "  /api/whale-ai/trade/status => HTTP $code (expect 404)"
  if [ "$code" != "404" ]; then
    echo "ERROR: strategy trade route still reachable (HTTP $code)"
    exit 8
  fi
  ok=1
  break
done

if [ "$ok" != "1" ]; then
  echo "health check failed"
  systemctl --no-pager --full status whale-tracker || true
  journalctl -u whale-tracker -n 40 --no-pager || true
  exit 7
fi

echo "==> deploy finished successfully"
