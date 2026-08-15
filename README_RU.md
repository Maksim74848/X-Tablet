# X‑Tablet — полный исходный проект

Это целевая структура X‑Tablet: сайт + Telegram-бот + Stars + лицензии + защищённые загрузки + desktop companion для X‑Plane 12.

## Структура

```text
X-Tablet/
├── index.html                 # сайт, в корне
├── client/                    # desktop companion
│   ├── main.go
│   ├── web/                    # встроенный интерфейс X‑Tablet
│   └── license-server.txt      # только публичный URL сервера лицензий
├── server/                    # Telegram + Stars + лицензии + загрузки
├── installer/                 # установщики Windows/Linux/macOS
│   ├── server.js
│   ├── config.example.json
│   └── downloads/
├── .github/workflows/         # сборки Windows/Linux/macOS
└── docs/
```

## Пользовательский путь

1. Пользователь выбирает тариф на сайте.
2. Сайт переводит его в Telegram-бота.
3. Бот создаёт Stars invoice (`XTR`).
4. После `successful_payment` бот создаёт/продлевает лицензию и выдаёт ключ.
5. Бот даёт короткую ссылку обратно на этот же сайт.
6. Сайт показывает защищённый раздел файлов и ссылки на Windows/Linux/macOS.
7. Пользователь скачивает программу.
8. В X‑Tablet открывает раздел **Лицензия**, вводит ключ.
9. Desktop-программа создаёт локальный `device_id` + `device_secret` и активирует их на сервере.
10. Второй ПК с тем же ключом получает `device_already_bound`.

## Тарифы

- Standard — 199 ⭐ / 30 дней, 1 ПК + 1 companion.
- Pro — 399 ⭐ / 30 дней, 1 ПК + до 4 companion-устройств + расширенные функции.

## Тестовый Hello World

Есть отдельный тестовый digital-product за 1 ⭐.

На сайте и сервере он включён конфигурацией `helloWorld.enabled`.
После проверки поставьте его в `false` на сервере и в `index.html`.

## Важно про GitHub Pages

`index.html` специально лежит в корне, потому что это удобный корневой entry point для статического хостинга.

Но GitHub Pages не является подходящим местом для коммерческого сайта с транзакциями, а на GitHub Free private repositories не дают обычный private Pages. Поэтому публичную витрину лучше размещать на отдельном статическом хостинге, а приватный GitHub использовать как код/исходники/CI. Сам `index.html` остаётся в корне репозитория.

## Секреты

В корневом `index.html` секретов нет.

Единственный обязательный серверный секрет для Telegram-магазина — Bot Token в `server/config.json`.
Он никогда не должен попадать в frontend или client build.
