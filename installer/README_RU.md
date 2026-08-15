# Установщики X-Tablet

## Windows
`windows/X-Tablet.iss` — Inno Setup 6. Внешний вид — стандартный modern wizard Inno Setup; скрипт создаёт ярлык и, по желанию, автозапуск.

## Linux
`linux/install.sh` устанавливает бинарник в `~/.local/bin`.

## macOS
`macos/build-dmg.sh` делает DMG из универсального `X-Tablet.app` (Intel + Apple Silicon).

GitHub Actions автоматически собирает эти артефакты при теге `v*`.
