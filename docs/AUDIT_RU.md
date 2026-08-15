# Финальный аудит X‑Tablet

## Telegram Stars

- Digital goods используют `currency = XTR`.
- Standard/Pro используют `subscription_period = 2592000` (30 дней).
- `pre_checkout_query` проверяется на пользователя, тип заказа и валюту.
- Лицензия создаётся только после `successful_payment`.
- `telegram_payment_charge_id` сохраняется для защиты от повторной обработки.
- Test product Hello World = 1 ⭐ можно отключить одной настройкой.

## Лицензирование

- Формат ключа: `XT-XXXXX-XXXXX-XXXXX-XXXXX`.
- Лицензия связана с Telegram user id.
- Первый `device_id` становится привязанным.
- Вместе с device id создаётся локальный `device_secret`.
- Сервер хранит только SHA-256 хэш device secret.
- Другой device id получает `409 device_already_bound`.
- Неправильный secret на том же device id получает `401 device_secret_invalid`.
- Heartbeat проверяет токен, device id и device secret.
- `/resetdevice` очищает привязку с 30-дневным cooldown.
- Ссылки на сайт и скачивание короткоживущие.

## Сайт

- `index.html` находится в корне.
- В публичном JS-конфиге нет Bot Token, GitHub Token, Wallet ключей или приватных ключей.
- После успешной оплаты бот возвращает пользователя на тот же сайт через короткую session-ссылку.
- Сайт получает данные с `/v1/site/session/<token>` и показывает ключ + доступные OS-файлы.
- `history.replaceState` очищает session token из адресной строки после загрузки портала.
- Hello World скрывается `helloWorldModule.enabled = false`.
- CSS использует responsive breakpoints; длинный текст переносится.

## Desktop

- `go test ./...` — PASS.
- `go vet ./...` — PASS.
- Windows x64 GUI build — PASS.
- Linux x64 build — PASS.
- macOS Intel build — PASS.
- macOS ARM64 cross-build не завершился в текущей среде по лимиту времени; workflow GitHub Actions содержит отдельную arm64 job.
- Лицензия вводится в разделе «Лицензия» в desktop UI.
- Device identity хранится в пользовательском каталоге с правами 0600.

## Важное ограничение

Защита лицензии предназначена против обычного копирования. Нельзя гарантировать DRM-уровень защиты от мотивированного reverse engineering локального desktop binary.

## Хостинг

GitHub Pages подходит технически для статического `index.html`, но GitHub ограничивает его использование для коммерческого e-commerce, а GitHub Free не даёт обычный Pages для private repositories. Поэтому приватный GitHub репозиторий лучше использовать как source/CI, а сам коммерческий сайт разместить отдельно.
