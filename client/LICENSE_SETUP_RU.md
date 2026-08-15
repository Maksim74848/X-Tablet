# Лицензирование X‑Tablet

Перед сборкой укажите публичный HTTPS URL license-server в `license-server.txt`.

Пример:

`https://license.example.com`

Это НЕ секрет. В этот файл нельзя помещать Bot Token или какие-либо приватные ключи.

При первом запуске X‑Tablet создаёт локальный `device_id` + `device_secret` в `%LOCALAPPDATA%/X-Tablet/license.json` (на Windows) или в каталоге пользователя Linux/macOS. Ключ лицензии вводится в разделе **Лицензия**.
