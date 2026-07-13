#!/bin/bash
# Установка VLESS Bridge helper на macOS.
# Использование: ./install-macos.sh <ID расширения>
set -e

EXT_ID="$1"
if [ -z "$EXT_ID" ]; then
  echo "Использование: $0 <ID расширения из chrome://extensions>"
  exit 1
fi

APP_DIR="$HOME/Library/Application Support/VLESSBridge"
NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$APP_DIR" "$NM_DIR"

# Бинарники должны лежать рядом со скриптом: helper и xray
cp "$SCRIPT_DIR/helper" "$APP_DIR/helper"
cp "$SCRIPT_DIR/xray" "$APP_DIR/xray"
chmod +x "$APP_DIR/helper" "$APP_DIR/xray"

# Базы geoip/geosite нужны xray для routing-правил вида geosite:category-ru /
# geoip:ru — без них конфиг из подписки не загрузится. Кладём рядом с xray.
for dat in geoip.dat geosite.dat; do
  if [ -f "$SCRIPT_DIR/$dat" ]; then
    cp "$SCRIPT_DIR/$dat" "$APP_DIR/$dat"
  else
    echo "ВНИМАНИЕ: $dat не найден рядом со скриптом — конфиги с geosite/geoip правилами не заработают."
  fi
done

# Ad-hoc подпись helper'а: после копирования поверх запущенного бинарника
# macOS может убить (SIGKILL) следующий запуск из-за инвалидации кеша подписи.
codesign --force --sign - "$APP_DIR/helper" 2>/dev/null || true

cat > "$NM_DIR/com.vlessbridge.helper.json" << EOF
{
  "name": "com.vlessbridge.helper",
  "description": "VLESS Bridge helper",
  "path": "$APP_DIR/helper",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF

echo "Готово. Helper установлен в $APP_DIR"
echo "Перезапустите Chrome, если он был открыт."
