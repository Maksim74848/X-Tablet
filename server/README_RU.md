# X‑Tablet Server

Сервер объединяет Telegram-бота, Telegram Stars, лицензии, защищённую страницу файлов и выдачу защищённых release-файлов.

## 1. Конфиг

Скопируйте `config.example.json` в `config.json` и замените:

- `botToken` — токен от @BotFather;
- `publicSiteUrl` — URL сайта, где лежит корневой `index.html`;
- `publicApiUrl` — публичный HTTPS URL этого сервера;
- `adminTelegramId` — ваш Telegram ID (необязательно, только для поддержки);
- имена файлов в `downloads`.

`config.json`, `data/` и `keys/` не должны попадать в Git.

## 2. Файлы

После сборки X‑Tablet положите release-файлы рядом с сервером:

`server/downloads/X-Tablet-Windows-x64.exe`

`server/downloads/X-Tablet-Linux-x64`

`server/downloads/X-Tablet-macOS-universal.zip`

## 3. Запуск

```bash
npm start
```

Сервер использует только Node.js без внешней БД. Для одного магазина с небольшой нагрузкой JSON-хранилище достаточно; при росте проекта его можно заменить на PostgreSQL без изменения публичного API.

## 4. Поток покупки

Сайт → Telegram → Stars → `successful_payment` → лицензия + ключ → временная сессия сайта → защищённые ZIP.

Telegram требует для цифровых товаров `currency = XTR`, обработку `pre_checkout_query` и выдачу товара только после `successful_payment`. Для bot-subscriptions Telegram использует 30 дней (`2592000` секунд).
