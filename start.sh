#!/bin/bash
# LearnOrNot · 学不学 启动脚本
# 需要代理时：在项目根放 local.config.json（{"proxy":"http://127.0.0.1:7897"}），
# 或直接 export HTTPS_PROXY 后再跑本脚本。
cd "$(dirname "$0")"
export PORT=${PORT:-3210}

# 读取可选的 local.config.json（proxy 字段）
if [ -f local.config.json ]; then
  PROXY=$(node -e "try{const c=require('./local.config.json');process.stdout.write(c.proxy||'')}catch(e){}" 2>/dev/null)
  if [ -n "$PROXY" ]; then
    export HTTPS_PROXY=${HTTPS_PROXY:-$PROXY}
    export HTTP_PROXY=${HTTP_PROXY:-$PROXY}
    export NODE_USE_ENV_PROXY=1
  fi
fi

echo "LearnOrNot 启动中… http://127.0.0.1:$PORT"
exec node server/index.js
