const DAY = 86400;

function todayKey() {
  return new Date()
    .toISOString()
    .slice(0, 10);
}

async function sendTelegram(
  config,
  chatId,
  text,
  replyMarkup = null
) {
  const response = await fetch(
    `https://api.telegram.org/bot${config.botToken}/sendMessage`,
    {
      method: "POST",
      headers: {
        "content-type":
          "application/json"
      },
      body: JSON.stringify({
        chat_id:
          Number(chatId),

        text,

        parse_mode:
          "HTML",

        ...(replyMarkup
          ? {
              reply_markup:
                replyMarkup
            }
          : {})
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `Telegram reminder failed: HTTP ${response.status}`
    );
  }
}

export function startSubscriptionReminders(
  config,
  store,
  saveStore
) {
  let running = false;

  async function run() {

    if (running) {
      return;
    }

    running = true;

    try {

      const current =
        Math.floor(
          Date.now() / 1000
        );

      const reminderDay =
        DAY * 7;

      const oneDay =
        DAY;

      const key =
        todayKey();

      for (
        const license of
        Object.values(
          store.licenses
        )
      ) {

        if (
          license.status !==
          "active"
        ) {
          continue;
        }

        const expiresAt =
          Number(
            license.expiresAt ||
            0
          );

        if (
          expiresAt <= current
        ) {
          continue;
        }

        const left =
          expiresAt -
          current;

        const telegramUserId =
          String(
            license.telegramUserId ||
            ""
          );

        if (!telegramUserId) {
          continue;
        }

        const plan =
          license.plan === "pro"
            ? "Pro"
            : "Standard";

        /*
         * 7 дней
         */

        if (
          left <=
            reminderDay &&
          left >
            6 * DAY &&
          license.reminder7dDate !==
            key
        ) {

          await sendTelegram(
            config,
            telegramUserId,

            `📅 <b>Подписка X-Tablet заканчивается через неделю</b>\n\n` +
            `Тариф: <b>${plan}</b>\n` +
            `Действует до: <b>${new Date(expiresAt * 1000).toLocaleDateString("ru-RU")}</b>\n\n` +
            `Продлите подписку заранее, чтобы не потерять доступ.`,

            {
              inline_keyboard: [
                [
                  {
                    text:
                      "⭐ Продлить подписку",

                    callback_data:
                      `buy_${license.plan}`
                  }
                ]
              ]
            }
          );

          license.reminder7dDate =
            key;

          license.updatedAt =
            new Date().toISOString();

          continue;
        }

        /*
         * 1 день
         */

        if (
          left <=
            oneDay &&
          left >
            0 &&
          license.reminder1dDate !==
            key
        ) {

          await sendTelegram(
            config,
            telegramUserId,

            `⚠️ <b>Подписка X-Tablet заканчивается завтра</b>\n\n` +
            `Тариф: <b>${plan}</b>\n` +
            `Действует до: <b>${new Date(expiresAt * 1000).toLocaleDateString("ru-RU")}</b>\n\n` +
            `Продлите её сейчас, чтобы X-Tablet продолжил работать.`,

            {
              inline_keyboard: [
                [
                  {
                    text:
                      "⭐ Продлить",

                    callback_data:
                      `buy_${license.plan}`
                  }
                ]
              ]
            }
          );

          license.reminder1dDate =
            key;

          license.updatedAt =
            new Date().toISOString();
        }

      }

      saveStore(store);

    } catch (error) {

      console.error(
        "[subscription-reminders]",
        error
      );

    } finally {

      running = false;

    }

  }

  run();

  setInterval(
    run,
    60 * 60 * 1000
  );
}
