const DAY = 86400;

function todayKey() {
  return new Date()
    .toISOString()
    .slice(0, 10);
}

async function telegram(
  config,
  chatId,
  text
) {
  const response =
    await fetch(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      {
        method: "POST",

        headers: {
          "content-type":
            "application/json"
        },

        body:
          JSON.stringify({
            chat_id:
              Number(chatId),

            text,

            parse_mode:
              "HTML",

            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      "⭐ Продлить подписку",

                    callback_data:
                      "buy"
                  }
                ]
              ]
            }
          })
      }
    );

  if (!response.ok) {
    throw new Error(
      `Telegram HTTP ${response.status}`
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

      const now =
        Math.floor(
          Date.now() / 1000
        );

      const today =
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

        const userId =
          String(
            license.telegramUserId ||
            ""
          );

        if (
          !userId ||
          expiresAt <= now
        ) {
          continue;
        }

        const left =
          expiresAt -
          now;

        const plan =
          license.plan ===
          "pro"
            ? "Pro"
            : "Standard";

        if (
          left <=
            7 * DAY &&
          left >
            6 * DAY &&
          license.reminder7dDate !==
            today
        ) {

          await telegram(
            config,
            userId,

            `📅 <b>Напоминание X-Tablet</b>\n\n` +
            `Ваша подписка <b>${plan}</b> ` +
            `заканчивается через неделю.\n\n` +
            `Дата окончания: <b>` +
            `${new Date(
              expiresAt * 1000
            ).toLocaleDateString(
              "ru-RU"
            )}` +
            `</b>\n\n` +
            `Продлите подписку заранее, ` +
            `чтобы X-Tablet продолжил работать.`
          );

          license.reminder7dDate =
            today;

          continue;
        }

        if (
          left <=
            DAY &&
          left > 0 &&
          license.reminder1dDate !==
            today
        ) {

          await telegram(
            config,
            userId,

            `⚠️ <b>X-Tablet заканчивается завтра</b>\n\n` +
            `Тариф: <b>${plan}</b>\n` +
            `Окончание: <b>` +
            `${new Date(
              expiresAt * 1000
            ).toLocaleDateString(
              "ru-RU"
            )}` +
            `</b>\n\n` +
            `Продлите подписку сейчас.`
          );

          license.reminder1dDate =
            today;
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
