# Что сделать после загрузки репозитория

1. Сделайте репозиторий X‑Tablet приватным.
2. Создайте Telegram-бота через @BotFather.
3. На сервере скопируйте `server/config.example.json` → `server/config.json`.
4. Вставьте туда Bot Token и публичные URL сайта/серверной части.
5. В `index.html` замените только `telegramBot`, `licenseApi`, `supportBot`.
6. В `client/license-server.txt` укажите HTTPS URL серверной части.
7. Соберите desktop через workflow. Windows-релиз — нормальный Inno Setup installer, Linux — tar.gz с install.sh, macOS — universal DMG.
8. Разместите эти три установщика в `server/downloads/` с именами из config. Именно эти файлы будут скачиваться пользователем через сайт после оплаты.
9. Запустите server: `npm install` (не требуется внешних пакетов) и `npm start`.
10. В BotFather используйте команду `/setcommands` и задайте:

`start - открыть X‑Tablet`
`buy - купить подписку`
`subscription - моя подписка`
`device - моё устройство`
`download - файлы X‑Tablet`
`resetdevice - перенести лицензию`
`support - техническая поддержка`
`paysupport - поддержка оплаты`

## Админ

Если хотите получать обращения поддержки в Telegram, поставьте свой numeric Telegram ID в `adminTelegramId`.

## Hello World

Сначала оставьте `helloWorld.enabled = true`, проверьте покупку на 1 ⭐ в тестовой среде Telegram, а затем отключите его (`false`).

## Админ-панель

После запуска license server откройте:

`https://YOUR_LICENSE_SERVER/admin.html`

Введите `adminToken` из `server/config.json`.

Важно: `index.html` не содержит Bot Token, adminToken или другие секреты.

## Данные Telegram-покупателя

При каждом входящем сообщении бот сохраняет минимальные поля Telegram-профиля, необходимые магазину: Telegram ID, username, имя/фамилию (если переданы) и технические данные покупки/лицензии. Эти данные доступны только через защищённый admin API.

## Вход через Telegram в приложении

В X-Tablet откройте «Аккаунт» → «Войти через Telegram». Программа создаст одноразовый код, откроет Telegram-бота и будет ждать подтверждение. После `Start` имя, фамилия, username и данные лицензии подтянутся в приложение. Если активная лицензия есть и ПК свободен, приложение предлагает автоматически привязать текущий ПК.
