import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(ROOT, 'config.json');
const DATA_DIR = path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const DOWNLOAD_DIR = path.join(ROOT, 'downloads');
const RELEASE_BASE_URL =
  'https://github.com/Maksim74848/X-Tablet/releases/latest/download';

function releaseUrl(fileName) {
  return `${RELEASE_BASE_URL}/${encodeURIComponent(fileName)}`;
}
async function proxyRemoteRelease(
  res,
  fileName
) {
  const response =
    await fetch(
      releaseUrl(fileName)
    );

  if (!response.ok) {
    return json(
      res,
      502,
      {
        error:
          'release_download_failed',
        message:
          `GitHub Release returned ${response.status}`,
      }
    );
  }

  const contentType =
    response.headers.get(
      'content-type'
    ) ||
    'application/octet-stream';

  const contentLength =
    response.headers.get(
      'content-length'
    );

  const headers = {
    'content-type':
      contentType,

    'content-disposition':
      `attachment; filename="${fileName.replaceAll('"', '')}"`,

    'cache-control':
      'private, no-store',

    'x-content-type-options':
      'nosniff',
  };

  if (contentLength) {
    headers['content-length'] =
      contentLength;
  }

  res.writeHead(
    200,
    headers
  );

  if (!response.body) {
    return res.end();
  }

  return Readable
    .fromWeb(response.body)
    .pipe(res);
}
function redirectRelease(res, fileName) {
  res.writeHead(302, {
    location: releaseUrl(fileName),
    'cache-control': 'no-store',
  });

  return res.end();
}
const KEYS_DIR = path.join(ROOT, 'keys');

const DAY = 86400;
const MONTH = 30 * DAY;
const SITE_SESSION_TTL = 20 * 60;
const DOWNLOAD_TTL = 30 * 60;
const DOWNLOAD_MAX_USES = 3;
const RESET_COOLDOWN = 30 * DAY;
const ACTIVATION_WINDOW = 60;
const ACTIVATION_LIMIT = 8;

const activationAttempts = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
fs.mkdirSync(KEYS_DIR, { recursive: true });

const now = () => Math.floor(Date.now() / 1000);
const iso = () => new Date().toISOString();

const randomHex = (bytes = 24) =>
  crypto.randomBytes(bytes).toString('hex');

const b64u = value =>
  Buffer.from(value).toString('base64url');

const fromB64u = value =>
  Buffer.from(value, 'base64url');

const DEFAULT_PLANS = Object.freeze({
  standard: {
    title: 'X-Tablet Standard',
    stars: 199,
    companionSlots: 1,
    entitlements: [
      'core',
      'flight_data',
      'commands',
      'hotkeys',
      'diagnostics',
    ],
  },

  pro: {
    title: 'X-Tablet Pro',
    stars: 399,
    companionSlots: 4,
    entitlements: [
      'core',
      'flight_data',
      'commands',
      'hotkeys',
      'diagnostics',
      'custom_layouts',
      'extra_panels',
      'profiles',
      'priority_updates',
    ],
  },
});

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(
      'Создай server/config.json по config.example.json'
    );
  }

  const config = JSON.parse(
    fs.readFileSync(CONFIG_FILE, 'utf8')
  );

  if (
    !config.botToken ||
    config.botToken.startsWith('PASTE_')
  ) {
    throw new Error(
      'В server/config.json не указан botToken'
    );
  }

  if (
    !config.publicSiteUrl ||
    config.publicSiteUrl.includes('YOUR_')
  ) {
    throw new Error(
      'В server/config.json не указан publicSiteUrl'
    );
  }

  if (
    !config.publicApiUrl ||
    config.publicApiUrl.includes('YOUR_')
  ) {
    throw new Error(
      'В server/config.json не указан publicApiUrl'
    );
  }

  if (
    !config.telegramBotUrl ||
    !/^https:\/\/t\.me\/[^\s]+$/.test(
      config.telegramBotUrl
    )
  ) {
    throw new Error(
      'В server/config.json не указан telegramBotUrl'
    );
  }

  if (
    !config.adminToken ||
    config.adminToken.startsWith('PASTE_') ||
    config.adminToken.length < 24
  ) {
    throw new Error(
      'В server/config.json не указан достаточно длинный adminToken'
    );
  }

  return config;
}

function defaultStore() {
  return {
    users: {},
    licenses: {},
    payments: {},
    purchaseSessions: {},
    downloadTokens: {},
    supportTickets: {},
    deviceLinks: {},
    auditLog: [],
  };
}

function loadStore() {
  if (!fs.existsSync(STORE_FILE)) {
    return defaultStore();
  }

  try {
    return {
      ...defaultStore(),
      ...JSON.parse(
        fs.readFileSync(STORE_FILE, 'utf8')
      ),
    };
  } catch (error) {
    throw new Error(
      `Не удалось прочитать store.json: ${error.message}`
    );
  }
}

function saveStore(store) {
  const tmp = `${STORE_FILE}.tmp`;

  fs.writeFileSync(
    tmp,
    JSON.stringify(store, null, 2),
    { mode: 0o600 }
  );

  fs.renameSync(tmp, STORE_FILE);
}

function ensureEd25519Keys() {
  const privatePath =
    path.join(KEYS_DIR, 'private.pem');

  const publicPath =
    path.join(KEYS_DIR, 'public.pem');

  if (
    !fs.existsSync(privatePath) ||
    !fs.existsSync(publicPath)
  ) {
    const pair =
      crypto.generateKeyPairSync('ed25519');

    fs.writeFileSync(
      privatePath,
      pair.privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      }),
      { mode: 0o600 }
    );

    fs.writeFileSync(
      publicPath,
      pair.publicKey.export({
        type: 'spki',
        format: 'pem',
      }),
      { mode: 0o644 }
    );
  }

  const privateKey =
    crypto.createPrivateKey(
      fs.readFileSync(privatePath, 'utf8')
    );

  const publicKey =
    crypto.createPublicKey(
      fs.readFileSync(publicPath, 'utf8')
    );

  return {
    privateKey,
    publicKey,
    publicRawB64:
      publicKey
        .export({
          type: 'spki',
          format: 'der',
        })
        .subarray(-32)
        .toString('base64'),
  };
}

function signToken(payload, keys) {
  const body = b64u(
    JSON.stringify(payload)
  );

  const signature = crypto.sign(
    null,
    Buffer.from(body),
    keys.privateKey
  );

  return `${body}.${b64u(signature)}`;
}

function verifyToken(token, keys) {
  try {
    const [
      body,
      signature,
    ] = String(token || '').split('.');

    if (!body || !signature) {
      return null;
    }

    if (
      !crypto.verify(
        null,
        Buffer.from(body),
        keys.publicKey,
        fromB64u(signature)
      )
    ) {
      return null;
    }

    const payload = JSON.parse(
      fromB64u(body).toString('utf8')
    );

    if (
      payload.exp &&
      payload.exp <= now()
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function normalizeLicenseKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function generateLicenseKey() {
  const chars =
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  let output = 'XT';

  for (
    let group = 0;
    group < 4;
    group += 1
  ) {
    let block = '';

    for (
      let i = 0;
      i < 5;
      i += 1
    ) {
      block +=
        chars[
          crypto.randomInt(chars.length)
        ];
    }

    output += `-${block}`;
  }

  return output;
}

function hashSecret(secret) {
  return crypto
    .createHash('sha256')
    .update(String(secret))
    .digest('hex');
}

function randomDeviceChallenge() {
  return randomHex(24);
}

function planOf(name) {
  return (
    DEFAULT_PLANS[name] ||
    DEFAULT_PLANS.standard
  );
}

function expectedStars(kind) {
  if (kind === 'standard') {
    return DEFAULT_PLANS.standard.stars;
  }

  if (kind === 'pro') {
    return DEFAULT_PLANS.pro.stars;
  }

  if (kind === 'hello') {
    return 1;
  }

  return null;
}

function planEntitlements(name) {
  return Object.fromEntries(
    planOf(name).entitlements.map(
      item => [item, true]
    )
  );
}

function findLicense(
  store,
  licenseKey
) {
  const normalized =
    normalizeLicenseKey(licenseKey);

  return Object.values(
    store.licenses
  ).find(
    item =>
      item.licenseKey === normalized
  ) || null;
}

function findUserLicense(
  store,
  telegramUserId
) {
  return Object.values(
    store.licenses
  ).find(
    item =>
      String(item.telegramUserId) ===
      String(telegramUserId)
  ) || null;
}

function currentPlan(license) {
  return license?.plan === 'pro'
    ? 'pro'
    : 'standard';
}

function isActive(license) {
  return Boolean(
    license &&
    license.status === 'active' &&
    Number(license.expiresAt) > now()
  );
}

function issueActivationToken(
  license,
  deviceId,
  keys
) {
  return signToken(
    {
      version: 1,
      product: 'x-tablet',
      licenseId: license.id,
      plan: license.plan,
      deviceId,
      exp: license.expiresAt,
      entitlements:
        planEntitlements(license.plan),
    },
    keys
  );
}

function publicLicense(license) {
  if (!license) {
    return null;
  }

  return {
    licenseId: license.id,
    licenseKey: license.licenseKey,
    plan: currentPlan(license),
    expiresAt: license.expiresAt,
    deviceBound: Boolean(
      license.deviceId
    ),
    companionSlots:
      planOf(license.plan)
        .companionSlots,
    entitlements:
      planEntitlements(
        license.plan
      ),
  };
}

function rememberTelegramUser(
  store,
  user
) {
  if (!user?.id) {
    return;
  }

  const id = String(user.id);

  const existing =
    store.users[id] || {
      telegramUserId: id,
      createdAt: iso(),
    };

  store.users[id] = {
    telegramUserId: id,
    username: String(
      user.username ||
      existing.username ||
      ''
    ),
    firstName: String(
      user.first_name ||
      existing.firstName ||
      ''
    ),
    lastName: String(
      user.last_name ||
      existing.lastName ||
      ''
    ),
    languageCode: String(
      user.language_code ||
      existing.languageCode ||
      ''
    ),
    isPremium: Boolean(
      user.is_premium ??
      existing.isPremium ??
      false
    ),
    termsAcceptedAt:
      existing.termsAcceptedAt ||
      null,
    updatedAt: iso(),
    createdAt:
      existing.createdAt ||
      iso(),
  };
}

function audit(
  store,
  action,
  telegramUserId,
  meta = {}
) {
  store.auditLog.push({
    id: `A-${randomHex(6).toUpperCase()}`,
    action,
    telegramUserId:
      telegramUserId
        ? String(telegramUserId)
        : null,
    meta,
    createdAt: iso(),
  });

  if (
    store.auditLog.length > 5000
  ) {
    store.auditLog =
      store.auditLog.slice(-5000);
  }
}

function adminAuthorized(
  req,
  config
) {
  const header =
    String(
      req.headers.authorization || ''
    );

  const supplied = Buffer.from(
    header.startsWith('Bearer ')
      ? header.slice(7)
      : ''
  );

  const expected = Buffer.from(
    String(config.adminToken || '')
  );

  return (
    supplied.length ===
      expected.length &&
    supplied.length > 0 &&
    crypto.timingSafeEqual(
      supplied,
      expected
    )
  );
}

/*
 * Telegram webhook secret.
 *
 * Он вычисляется из BOT_TOKEN и не требует
 * отдельной переменной Render.
 */
function telegramWebhookSecret(
  config
) {
  return crypto
    .createHash('sha256')
    .update(
      `x-tablet-webhook:${config.botToken}`
    )
    .digest('hex');
}

function adminSummary(store) {
  const licenses =
    Object.values(store.licenses);

  const payments =
    Object.values(store.payments);

  const users =
    Object.values(store.users);

  const active =
    licenses.filter(isActive).length;

  const standard =
    licenses.filter(
      x =>
        x.plan === 'standard' &&
        isActive(x)
    ).length;

  const pro =
    licenses.filter(
      x =>
        x.plan === 'pro' &&
        isActive(x)
    ).length;

  const stars =
    payments.reduce(
      (sum, x) =>
        sum + Number(x.amount || 0),
      0
    );

  return {
    users: users.length,
    licenses: licenses.length,
    activeLicenses: active,
    activeStandard: standard,
    activePro: pro,
    payments: payments.length,
    stars,
    openSupport:
      Object.values(
        store.supportTickets
      ).filter(
        x => x.status === 'open'
      ).length,
  };
}

function sanitizeAdminUser(
  store,
  telegramUserId
) {
  const user =
    store.users[
      String(telegramUserId)
    ] || {};

  const license =
    findUserLicense(
      store,
      telegramUserId
    );

  return {
    telegramUserId:
      String(telegramUserId),
    username:
      user.username || '',
    firstName:
      user.firstName || '',
    lastName:
      user.lastName || '',
    languageCode:
      user.languageCode || '',
    isPremium:
      Boolean(user.isPremium),
    createdAt:
      user.createdAt || null,
    updatedAt:
      user.updatedAt || null,
    license:
      license
        ? publicLicense(license)
        : null,
  };
}

function adminData(store) {
  const users =
    Object.keys(store.users)
      .map(id =>
        sanitizeAdminUser(
          store,
          id
        )
      );

  const payments =
    Object.entries(
      store.payments
    )
      .map(
        ([chargeId, p]) => ({
          chargeId,
          telegramUserId:
            String(
              p.telegramUserId
            ),
          username:
            store.users[
              String(
                p.telegramUserId
              )
            ]?.username || '',
          plan: p.plan,
          amount: p.amount,
          currency: p.currency,
          createdAt:
            p.createdAt,
        })
      )
      .sort(
        (a, b) =>
          String(b.createdAt)
            .localeCompare(
              String(a.createdAt)
            )
      );

  const licenses =
    Object.values(
      store.licenses
    )
      .map(l => ({
        ...publicLicense(l),
        telegramUserId:
          String(l.telegramUserId),
        username:
          store.users[
            String(
              l.telegramUserId
            )
          ]?.username || '',
        deviceId:
          l.deviceId || null,
        lastPaymentAt:
          l.lastPaymentAt,
        updatedAt:
          l.updatedAt,
      }))
      .sort(
        (a, b) =>
          Number(b.expiresAt) -
          Number(a.expiresAt)
      );

  const tickets =
    Object.values(
      store.supportTickets
    )
      .map(t => ({
        ...t,
        username:
          store.users[
            String(
              t.telegramUserId
            )
          ]?.username ||
          t.username ||
          '',
      }))
      .sort(
        (a, b) =>
          String(b.createdAt)
            .localeCompare(
              String(a.createdAt)
            )
      );

  return {
    summary:
      adminSummary(store),
    users,
    payments,
    licenses,
    tickets,
  };
}

function privacyDelete(
  store,
  telegramUserId
) {
  const id =
    String(telegramUserId);

  delete store.users[id];

  for (
    const [
      licenseId,
      license
    ] of Object.entries(
      store.licenses
    )
  ) {
    if (
      String(
        license.telegramUserId
      ) === id
    ) {
      delete store.licenses[
        licenseId
      ];
    }
  }

  for (
    const [
      chargeId,
      payment
    ] of Object.entries(
      store.payments
    )
  ) {
    if (
      String(
        payment.telegramUserId
      ) === id
    ) {
      delete store.payments[
        chargeId
      ];
    }
  }

  for (
    const [
      token,
      session
    ] of Object.entries(
      store.purchaseSessions
    )
  ) {
    if (
      String(
        session.telegramUserId
      ) === id
    ) {
      delete store.purchaseSessions[
        token
      ];
    }
  }

  for (
    const [
      token,
      dl
    ] of Object.entries(
      store.downloadTokens
    )
  ) {
    if (
      String(
        dl.telegramUserId
      ) === id
    ) {
      delete store.downloadTokens[
        token
      ];
    }
  }

  for (
    const [
      ticketId,
      ticket
    ] of Object.entries(
      store.supportTickets
    )
  ) {
    if (
      String(
        ticket.telegramUserId
      ) === id
    ) {
      delete store.supportTickets[
        ticketId
      ];
    }
  }

  audit(
    store,
    'privacy_delete',
    id
  );

  saveStore(store);
}

async function telegram(
  method,
  body,
  config
) {
  const response = await fetch(
    `https://api.telegram.org/bot${config.botToken}/${method}`,
    {
      method: 'POST',
      headers: {
        'content-type':
          'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  const json =
    await response.json();

  if (!json.ok) {
    throw new Error(
      json.description ||
      `Telegram ${method} failed`
    );
  }

  return json.result;
}

async function sendText(
  config,
  chatId,
  text,
  replyMarkup
) {
  return telegram(
    'sendMessage',
    {
      chat_id: Number(chatId),
      text,
      parse_mode: 'HTML',
      ...(replyMarkup
        ? {
            reply_markup:
              replyMarkup,
          }
        : {}),
    },
    config
  );
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll(
      '\"',
      '&quot;'
    );
}

async function answerCallback(
  config,
  id,
  text,
  showAlert = false
) {
  return telegram(
    'answerCallbackQuery',
    {
      callback_query_id: id,
      ...(text
        ? { text }
        : {}),
      show_alert: showAlert,
    },
    config
  );
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: '🛒 Купить',
          callback_data: 'buy',
        },
        {
          text: '👤 Аккаунт',
          callback_data:
            'subscription',
        },
      ],
      [
        {
          text: '⬇️ Мои файлы',
          callback_data: 'files',
        },
        {
          text: '📱 Устройство',
          callback_data:
            'device',
        },
      ],
      [
        {
          text: '🆘 Поддержка',
          callback_data:
            'support',
        },
      ],
    ],
  };
}

function planKeyboard() {
  const buttons = [
    [
      {
        text:
          `⭐ Standard — ${DEFAULT_PLANS.standard.stars}`,
        callback_data:
          'buy_standard',
      },
    ],
    [
      {
        text:
          `🚀 Pro — ${DEFAULT_PLANS.pro.stars}`,
        callback_data:
          'buy_pro',
      },
    ],
  ];

  return {
    inline_keyboard:
      buttons.concat([
        [
          {
            text: '◀️ Назад',
            callback_data:
              'home',
          },
        ],
      ]),
  };
}

function fileKeyboard(
  sessionUrlBase
) {
  return {
    inline_keyboard: [
      [
        {
          text: '🪟 Windows',
          url:
            `${sessionUrlBase}&platform=windows`,
        },
      ],
      [
        {
          text: '🐧 Linux',
          url:
            `${sessionUrlBase}&platform=linux`,
        },
      ],
      [
        {
          text: '🍎 macOS',
          url:
            `${sessionUrlBase}&platform=macos`,
        },
      ],
    ],
  };
}

function createPurchaseSession(
  store,
  license
) {
  const token =
    randomHex(24);

  store.purchaseSessions[
    token
  ] = {
    token,
    licenseId:
      license.id,
    telegramUserId:
      String(
        license.telegramUserId
      ),
    expiresAt:
      now() +
      SITE_SESSION_TTL,
    createdAt: iso(),
  };

  return token;
}

function createDownloadToken(
  store,
  licenseId,
  telegramUserId,
  platform
) {
  const token =
    randomHex(24);

  store.downloadTokens[
    token
  ] = {
    token,
    licenseId,
    telegramUserId:
      String(telegramUserId),
    platform,
    expiresAt:
      now() +
      DOWNLOAD_TTL,
    uses: 0,
    maxUses:
      DOWNLOAD_MAX_USES,
    createdAt: iso(),
  };

  return token;
}

function createDeviceLink(
  store,
  deviceId
) {
  const code =
    randomHex(16);

  store.deviceLinks[
    code
  ] = {
    code,
    deviceId:
      String(deviceId),
    telegramUserId: null,
    expiresAt:
      now() + 10 * 60,
    createdAt: iso(),
    consumedAt: null,
  };

  return code;
}

function findDeviceLink(
  store,
  code
) {
  const entry =
    store.deviceLinks[
      String(code || '')
    ];

  if (!entry) {
    return null;
  }

  if (
    entry.expiresAt <= now()
  ) {
    delete store.deviceLinks[
      entry.code
    ];

    saveStore(store);

    return null;
  }

  return entry;
}

function userProfile(
  store,
  telegramUserId
) {
  const u =
    store.users[
      String(telegramUserId)
    ] || {};

  const license =
    findUserLicense(
      store,
      telegramUserId
    );

  return {
    telegramUserId:
      String(telegramUserId),
    firstName:
      u.firstName || '',
    lastName:
      u.lastName || '',
    username:
      u.username || '',
    languageCode:
      u.languageCode || '',
    isPremium:
      Boolean(u.isPremium),
    plan:
      license
        ? currentPlan(license)
        : null,
    expiresAt:
      license
        ? Number(
            license.expiresAt ||
            0
          )
        : 0,
    licenseKey:
      license?.licenseKey ||
      null,
    deviceBound:
      Boolean(
        license?.deviceId
      ),
    deviceId:
      license?.deviceId ||
      null,
    active:
      Boolean(
        license &&
        isActive(license)
      ),
  };
}

function safeFileName(
  config,
  platform
) {
  const name =
    config.downloads?.[
      platform
    ];

  if (
    !name ||
    !/^[A-Za-z0-9._-]+$/.test(
      name
    )
  ) {
    return null;
  }

  return name;
}

function buildSiteSessionUrl(
  config,
  sessionToken
) {
  return `${config.publicSiteUrl.replace(/\/$/, '')}/?session=${encodeURIComponent(sessionToken)}`;
}

function issueSiteSession(
  store,
  config,
  license
) {
  const token =
    createPurchaseSession(
      store,
      license
    );

  const url =
    buildSiteSessionUrl(
      config,
      token
    );

  saveStore(store);

  return url;
}

async function sendPostPayment(
  config,
  store,
  license,
  chatId
) {
  const siteUrl =
    issueSiteSession(
      store,
      config,
      license
    );

  const expiry =
    new Date(
      license.expiresAt *
      1000
    ).toLocaleDateString(
      'ru-RU'
    );

  await sendText(
    config,
    chatId,
    `✅ <b>Покупка подтверждена</b>\n\n` +
    `Тариф: <b>${
      currentPlan(license) ===
      'pro'
        ? 'Pro'
        : 'Standard'
    }</b>\n` +
    `Действует до: <b>${expiry}</b>\n\n` +
    `🔑 Ваш ключ лицензии:\n` +
    `<code>${license.licenseKey}</code>\n\n` +
    `Нажмите кнопку ниже — сайт откроется уже с вашим доступом. Там выберите Windows, Linux или macOS.`,
    {
      inline_keyboard: [
        [
          {
            text:
              '🌐 Открыть мои файлы',
            url: siteUrl,
          },
        ],
        [
          {
            text:
              '📱 Как активировать',
            callback_data:
              'how_activate',
          },
        ],
        [
          {
            text:
              '👤 Моя подписка',
            callback_data:
              'subscription',
          },
        ],
      ],
    }
  );
}

function hasActiveSubscription(
  store,
  telegramUserId
) {
  const license =
    findUserLicense(
      store,
      telegramUserId
    );

  return license &&
    isActive(license)
    ? license
    : null;
}

async function sendInvoice(
  config,
  userId,
  plan
) {
  const p =
    planOf(plan);

  const payload =
    `xt:${plan}:${userId}:${randomHex(8)}`;

  return telegram(
    'sendInvoice',
    {
      chat_id:
        Number(userId),
      title: p.title,
      description:
        plan === 'pro'
          ? '30 дней X-Tablet Pro: один ПК, до 4 companion-устройств, custom layouts и расширенные панели.'
          : '30 дней X-Tablet Standard: один ПК, один companion-экран, live-данные, команды и диагностика.',
      payload,
      currency: 'XTR',
      prices: [
        {
          label: p.title,
          amount: p.stars,
        },
      ],
      subscription_period:
        MONTH,
      start_parameter:
        `buy_${plan}`,
    },
    config
  );
}

async function sendHelloWorldInvoice(
  config,
  userId
) {
  const payload =
    `xt:hello:${userId}:${randomHex(8)}`;

  return telegram(
    'sendInvoice',
    {
      chat_id:
        Number(userId),
      title:
        'Hello World',
      description:
        'Тестовый цифровой товар за 1 Telegram Star.',
      payload,
      currency: 'XTR',
      prices: [
        {
          label:
            'Hello World',
          amount: 1,
        },
      ],
      start_parameter:
        'buy_hello_world',
    },
    config
  );
}

function parsePayload(
  payload
) {
  const parts =
    String(payload || '')
      .split(':');

  if (
    parts.length !== 4 ||
    parts[0] !== 'xt'
  ) {
    return null;
  }

  return {
    kind: parts[1],
    telegramUserId:
      parts[2],
    nonce: parts[3],
  };
}

function upsertLicenseAfterPayment(
  store,
  telegramUserId,
  plan,
  successfulPayment
) {
  const chargeId =
    successfulPayment
      .telegram_payment_charge_id;

  if (
    chargeId &&
    store.payments[
      chargeId
    ]
  ) {
    return {
      license:
        store.licenses[
          store.payments[
            chargeId
          ].licenseId
        ],
      duplicate: true,
    };
  }

  let license =
    findUserLicense(
      store,
      telegramUserId
    );

  const expiryFromTelegram =
    Number(
      successfulPayment
        .subscription_expiration_date ||
      0
    );

  const expiry =
    expiryFromTelegram ||
    now() + MONTH;

  if (!license) {
    license = {
      id:
        `LIC-${randomHex(8).toUpperCase()}`,
      licenseKey:
        generateLicenseKey(),
      telegramUserId:
        String(
          telegramUserId
        ),
      plan,
      status:
        'active',
      expiresAt:
        expiry,
      deviceId:
        null,
      deviceSecretHash:
        null,
      resetAt:
        0,
      createdAt:
        iso(),
      updatedAt:
        iso(),
      lastPaymentAt:
        iso(),
    };

    store.licenses[
      license.id
    ] = license;
  } else {
    license.plan =
      plan;

    license.status =
      'active';

    license.expiresAt =
      Math.max(
        Number(
          license.expiresAt ||
          0
        ),
        expiry
      );

    license.updatedAt =
      iso();

    license.lastPaymentAt =
      iso();
  }

  if (chargeId) {
    store.payments[
      chargeId
    ] = {
      licenseId:
        license.id,
      telegramUserId:
        String(
          telegramUserId
        ),
      plan,
      amount:
        successfulPayment.total_amount,
      currency:
        successfulPayment.currency,
      createdAt:
        iso(),
    };
  }

  return {
    license,
    duplicate: false,
  };
}

async function handleTelegramUpdate(
  config,
  store,
  keys,
  update
) {
  if (update.pre_checkout_query) {
    const query =
      update.pre_checkout_query;

    const parsed =
      parsePayload(
        query.invoice_payload
      );

    const expected =
      parsed
        ? expectedStars(
            parsed.kind
          )
        : null;

    const valid =
      parsed &&
      expected !== null &&
      String(
        parsed.telegramUserId
      ) ===
        String(query.from.id) &&
      query.currency ===
        'XTR' &&
      Number(
        query.total_amount
      ) === expected &&
      (
        ['standard', 'pro']
          .includes(
            parsed.kind
          ) ||
        (
          parsed.kind ===
            'hello' &&
          config.helloWorld?.enabled
        )
      );

    await telegram(
      'answerPreCheckoutQuery',
      {
        pre_checkout_query_id:
          query.id,
        ok:
          Boolean(valid),
        ...(valid
          ? {}
          : {
              error_message:
                'Заказ недействителен. Начните покупку заново.',
            }),
      },
      config
    );

    return;
  }

  if (update.callback_query) {
    const callback =
      update.callback_query;

    rememberTelegramUser(
      store,
      callback.from
    );

    const chatId =
      callback.message?.chat?.id ||
      callback.from.id;

    await answerCallback(
      config,
      callback.id
    );

    if (
      callback.data ===
      'home'
    ) {
      await sendText(
        config,
        chatId,
        '<b>✈️ X-TABLET</b>\n\nВаш companion cockpit для X-Plane 12.',
        mainKeyboard()
      );

      return;
    }

    if (
      callback.data ===
      'buy'
    ) {
      await sendText(
        config,
        chatId,
        '<b>🛒 X-TABLET</b>\n\nВыберите тариф:',
        planKeyboard()
      );

      if (
        config.helloWorld?.enabled
      ) {
        await sendText(
          config,
          chatId,
          '🧪 Тестовый модуль Hello World: 1 ⭐',
          {
            inline_keyboard: [
              [
                {
                  text:
                    '⭐ Купить Hello World',
                  callback_data:
                    'buy_hello',
                },
              ],
            ],
          }
        );
      }

      return;
    }

    if (
      callback.data ===
        'buy_standard' ||
      callback.data ===
        'buy_pro'
    ) {
      const plan =
        callback.data ===
        'buy_pro'
          ? 'pro'
          : 'standard';

      const active =
        hasActiveSubscription(
          store,
          callback.from.id
        );

      if (active) {
        await sendText(
          config,
          callback.from.id,
          `🟢 У вас уже активна подписка <b>${
            currentPlan(active) ===
            'pro'
              ? 'Pro'
              : 'Standard'
          }</b> до <b>${
            new Date(
              active.expiresAt *
              1000
            ).toLocaleDateString(
              'ru-RU'
            )
          }</b>.\n\nЧтобы не создать вторую подписку, используйте /subscription.`,
          mainKeyboard()
        );

        return;
      }

      const user =
        store.users[
          String(
            callback.from.id
          )
        ] || {};

      if (
        !user.termsAcceptedAt
      ) {
        await sendText(
          config,
          callback.from.id,
          '<b>Перед покупкой</b>\n\nПрочитайте условия использования и политику конфиденциальности.',
          {
            inline_keyboard: [
              [
                {
                  text:
                    '📄 Условия',
                  callback_data:
                    'terms_view',
                },
                {
                  text:
                    '🔒 Конфиденциальность',
                  callback_data:
                    'privacy_view',
                },
              ],
              [
                {
                  text:
                    '✅ Принимаю условия',
                  callback_data:
                    `accept_terms_${plan}`,
                },
              ],
              [
                {
                  text:
                    '◀️ Назад',
                  callback_data:
                    'buy',
                },
              ],
            ],
          }
        );

        return;
      }

      await sendInvoice(
        config,
        callback.from.id,
        plan
      );

      return;
    }

    if (
      callback.data.startsWith(
        'accept_terms_'
      )
    ) {
      const plan =
        callback.data.endsWith(
          'pro'
        )
          ? 'pro'
          : 'standard';

      const user =
        store.users[
          String(
            callback.from.id
          )
        ] || {
          telegramUserId:
            String(
              callback.from.id
            ),
        };

      user.termsAcceptedAt =
        iso();

      store.users[
        String(
          callback.from.id
        )
      ] = {
        ...user,
        updatedAt:
          iso(),
      };

      audit(
        store,
        'terms_accepted',
        String(
          callback.from.id
        ),
        { plan }
      );

      saveStore(store);

      await sendInvoice(
        config,
        callback.from.id,
        plan
      );

      return;
    }

    if (
      callback.data ===
      'terms_view'
    ) {
      await sendText(
        config,
        callback.from.id,
        `<b>📄 Условия X-Tablet</b>\n\nX-Tablet — цифровой companion для X-Plane 12. Оплата цифровой подписки проходит через Telegram Stars. После успешного платежа пользователь получает лицензию на выбранный период. Лицензия Standard/Pro привязывается к одному ПК; перенос выполняется через /resetdevice.\n\nПоддержка: /support\nПлатёжные вопросы: /paysupport`,
        {
          inline_keyboard: [
            [
              {
                text:
                  '🔒 Конфиденциальность',
                callback_data:
                  'privacy_view',
              },
            ],
            [
              {
                text:
                  '◀️ Назад',
                callback_data:
                  'buy',
              },
            ],
          ],
        }
      );

      return;
    }

    if (
      callback.data ===
      'privacy_view'
    ) {
      await sendText(
        config,
        callback.from.id,
        `<b>🔒 Конфиденциальность</b>\n\nМы храним Telegram ID, публичные имя/username, сведения о покупке и лицензии и технический Device ID, необходимый для привязки лицензии. Не собираем телефон, email или платёжные реквизиты. Данные используются для оплаты, выдачи лицензии, скачивания и поддержки.`,
        {
          inline_keyboard: [
            [
              {
                text:
                  '📄 Условия',
                callback_data:
                  'terms_view',
              },
            ],
            [
              {
                text:
                  '◀️ Назад',
                callback_data:
                  'buy',
              },
            ],
          ],
        }
      );

      return;
    }

    if (
      callback.data ===
      'buy_hello'
    ) {
      if (
        !config.helloWorld?.enabled
      ) {
        return;
      }

      await sendHelloWorldInvoice(
        config,
        callback.from.id
      );

      return;
    }

    if (
      callback.data ===
        'account' ||
      callback.data ===
        'subscription'
    ) {
      const license =
        findUserLicense(
          store,
          callback.from.id
        );

      if (
        !license ||
        !isActive(license)
      ) {
        await sendText(
          config,
          chatId,
          '🔴 Активной подписки нет.\n\nНажмите «Купить X-Tablet».',
          planKeyboard()
        );
      } else {
        const expiry =
          new Date(
            license.expiresAt *
            1000
          ).toLocaleString(
            'ru-RU'
          );

        await sendText(
          config,
          chatId,
          `👤 <b>Моя подписка</b>\n\nТариф: <b>${
            currentPlan(
              license
            ) === 'pro'
              ? 'Pro'
              : 'Standard'
          }</b>\nСтатус: 🟢 активна\nДо: <b>${expiry}</b>\n\nЛицензия:\n<code>${license.licenseKey}</code>`,
          mainKeyboard()
        );
      }

      return;
    }

    if (
      callback.data ===
      'device'
    ) {
      const license =
        findUserLicense(
          store,
          callback.from.id
        );

      await sendText(
        config,
        chatId,
        license?.deviceId
          ? `📱 Устройство привязано.\n\n<code>${license.deviceId}</code>\n\nСмена устройства: /resetdevice`
          : '📱 Устройство ещё не активировано.\n\nУстановите X-Tablet и введите выданный ключ лицензии.',
        mainKeyboard()
      );

      return;
    }

    if (
      callback.data ===
      'files'
    ) {
      const license =
        findUserLicense(
          store,
          callback.from.id
        );

      if (
        !license ||
        !isActive(license)
      ) {
        await sendText(
          config,
          chatId,
          '🔒 Для доступа к файлам нужна активная подписка.',
          planKeyboard()
        );
      } else {
        const siteUrl =
          issueSiteSession(
            store,
            config,
            license
          );

        await sendText(
          config,
          chatId,
          '⬇️ <b>Файлы X-Tablet</b>\n\nОткройте защищённую страницу скачивания:',
          {
            inline_keyboard: [
              [
                {
                  text:
                    '🌐 Открыть файлы',
                  url:
                    siteUrl,
                },
              ],
            ],
          }
        );
      }

      return;
    }

    if (
      callback.data ===
      'support'
    ) {
      await sendText(
        config,
        chatId,
        '<b>🆘 Поддержка</b>\n\nОпиши проблему одним сообщением.\n\nПо вопросам оплаты используй /paysupport.',
        mainKeyboard()
      );

      return;
    }

    if (
      callback.data ===
      'how_activate'
    ) {
      await sendText(
        config,
        chatId,
        '<b>📱 Активация X-Tablet</b>\n\n1. Скачайте версию для своей ОС.\n2. Запустите X-Tablet.\n3. Откройте раздел «Лицензия».\n4. Введите ключ, который бот выдал после покупки.\n5. Нажмите «Активировать».\n\nКлюч привязывается к первому активированному ПК.',
        mainKeyboard()
      );

      return;
    }

    return;
  }

  const message =
    update.message;

  if (!message) {
    return;
  }

  rememberTelegramUser(
    store,
    message.from
  );

  const userId =
    message.from?.id;

  const text =
    String(
      message.text || ''
    ).trim();

  const command =
    text
      .split(/\s+/)[0]
      .split('@')[0];

  const arg =
    text.split(/\s+/)[1] ||
    '';

  if (
    command === '/start' &&
    arg.startsWith('link_')
  ) {
    const code =
      arg.slice(
        'link_'.length
      );

    const entry =
      findDeviceLink(
        store,
        code
      );

    if (
      !entry ||
      entry.consumedAt
    ) {
      await sendText(
        config,
        userId,
        '❌ Код входа истёк или уже использован. Откройте X-Tablet и создайте новый код.',
        mainKeyboard()
      );

      return;
    }

    entry.telegramUserId =
      String(userId);

    entry.consumedAt =
      iso();

    store.deviceLinks[
      code
    ] = entry;

    audit(
      store,
      'device_linked',
      String(userId),
      {
        deviceId:
          entry.deviceId,
      }
    );

    saveStore(store);

    const license =
      findUserLicense(
        store,
        userId
      );

    await sendText(
      config,
      userId,
      license &&
      isActive(license)
        ? `✅ <b>X-Tablet подключён</b>\n\nАккаунт <b>${escapeHtml([
            store.users[
              String(userId)
            ]?.firstName,
            store.users[
              String(userId)
            ]?.lastName,
          ]
            .filter(Boolean)
            .join(' ') ||
            'Telegram')}</b> найден. Теперь вернитесь в X-Tablet — данные аккаунта и подписки подтянутся автоматически.`
        : `✅ <b>Telegram подключён</b>\n\nАктивной подписки на этом аккаунте сейчас нет.`,
      mainKeyboard()
    );

    return;
  }

  if (
    message.successful_payment
  ) {
    const payment =
      message.successful_payment;

    if (
      payment.currency !==
      'XTR'
    ) {
      return;
    }

    const parsed =
      parsePayload(
        payment.invoice_payload
      );

    if (
      !parsed ||
      String(
        parsed.telegramUserId
      ) !== String(userId)
    ) {
      return;
    }

    if (
      parsed.kind ===
      'hello'
    ) {
      if (
        !config.helloWorld?.enabled
      ) {
        return;
      }

      await sendText(
        config,
        userId,
        `✅ <b>Hello World оплачен</b>\n\nPayment ID:\n<code>${payment.telegram_payment_charge_id}</code>\n\nТестовая цепочка Stars работает.`,
        mainKeyboard()
      );

      return;
    }

    if (
      ![
        'standard',
        'pro',
      ].includes(
        parsed.kind
      )
    ) {
      return;
    }

    const expected =
      expectedStars(
        parsed.kind
      );

    if (
      Number(
        payment.total_amount
      ) !== expected ||
      payment.currency !==
        'XTR'
    ) {
      console.error(
        '[payment] amount/currency mismatch',
        {
          userId,
          kind:
            parsed.kind,
          amount:
            payment.total_amount,
          currency:
            payment.currency,
        }
      );

      return;
    }

    const result =
      upsertLicenseAfterPayment(
        store,
        String(userId),
        parsed.kind,
        payment
      );

    audit(
      store,
      result.duplicate
        ? 'payment_duplicate_ignored'
        : 'payment_success',
      String(userId),
      {
        plan:
          parsed.kind,
        amount:
          payment.total_amount,
        chargeId:
          payment.telegram_payment_charge_id,
      }
    );

    saveStore(store);

    if (
      !result.duplicate
    ) {
      await sendPostPayment(
        config,
        store,
        result.license,
        userId
      );
    }

    return;
  }

  if (
    command === '/start'
  ) {
    if (
      [
        'buy_standard',
        'buy_pro',
      ].includes(arg)
    ) {
      const plan =
        arg ===
        'buy_pro'
          ? 'pro'
          : 'standard';

      const active =
        hasActiveSubscription(
          store,
          userId
        );

      if (active) {
        await sendText(
          config,
          userId,
          `🟢 У вас уже активна подписка <b>${
            currentPlan(active) ===
            'pro'
              ? 'Pro'
              : 'Standard'
          }</b> до <b>${
            new Date(
              active.expiresAt *
              1000
            ).toLocaleDateString(
              'ru-RU'
            )
          }</b>.\n\nНовая подписка не создаётся, чтобы не списать Stars дважды.`,
          mainKeyboard()
        );

        return;
      }

      const knownUser =
        store.users[
          String(userId)
        ] || {};

      if (
        !knownUser.termsAcceptedAt
      ) {
        await sendText(
          config,
          userId,
          '<b>Перед покупкой</b>\n\nПрочитайте условия и подтвердите согласие:',
          {
            inline_keyboard: [
              [
                {
                  text:
                    '📄 Условия',
                  callback_data:
                    'terms_view',
                },
                {
                  text:
                    '🔒 Конфиденциальность',
                  callback_data:
                    'privacy_view',
                },
              ],
              [
                {
                  text:
                    '✅ Принимаю условия',
                  callback_data:
                    `accept_terms_${plan}`,
                },
              ],
            ],
          }
        );

        return;
      }

      await sendInvoice(
        config,
        userId,
        plan
      );

      return;
    }

    if (
      arg ===
        'buy_hello_world' &&
      config.helloWorld?.enabled
    ) {
      await sendHelloWorldInvoice(
        config,
        userId
      );

      return;
    }

    await sendText(
      config,
      userId,
      '<b>✈️ X-TABLET</b>\n\nCompanion cockpit для X-Plane 12.\n\nТелефон или планшет становится дополнительным экраном и панелью управления.',
      mainKeyboard()
    );

    return;
  }

  if (
    command === '/buy'
  ) {
    await sendText(
      config,
      userId,
      '<b>🛒 X-TABLET</b>\n\nВыберите тариф:',
      planKeyboard()
    );

    return;
  }

  if (
    command === '/license'
  ) {
    const license =
      findUserLicense(
        store,
        userId
      );

    if (
      !license ||
      !isActive(license)
    ) {
      await sendText(
        config,
        userId,
        '🔴 Активной подписки нет.',
        planKeyboard()
      );

      return;
    }

    const siteUrl =
      issueSiteSession(
        store,
        config,
        license
      );

    await sendText(
      config,
      userId,
      `🔑 <b>Ваша лицензия</b>\n\nТариф: ${
        currentPlan(
          license
        ) === 'pro'
          ? 'Pro'
          : 'Standard'
      }\nДо: ${
        new Date(
          license.expiresAt *
          1000
        ).toLocaleDateString(
          'ru-RU'
        )}\n\n<code>${license.licenseKey}</code>`,
      {
        inline_keyboard: [
          [
            {
              text:
                '🌐 Открыть мои файлы',
              url:
                siteUrl,
            },
          ],
          [
            {
              text:
                '◀️ Главное меню',
              callback_data:
                'home',
            },
          ],
        ],
      }
    );

    return;
  }

  if (
    command === '/download'
  ) {
    const license =
      findUserLicense(
        store,
        userId
      );

    if (
      !license ||
      !isActive(license)
    ) {
      await sendText(
        config,
        userId,
        '🔒 Для скачивания нужна активная подписка.',
        planKeyboard()
      );

      return;
    }

    const siteUrl =
      issueSiteSession(
        store,
        config,
        license
      );

    await sendText(
      config,
      userId,
      '⬇️ <b>Файлы X-Tablet</b>\n\nОткройте защищённую страницу:',
      {
        inline_keyboard: [
          [
            {
              text:
                '🌐 Открыть файлы',
              url:
                siteUrl,
            },
          ],
        ],
      }
    );

    return;
  }

  if (
    command === '/account'
  ) {
    const license =
      findUserLicense(
        store,
        userId
      );

    const u =
      store.users[
        String(userId)
      ] || {};

    const full =
      escapeHtml(
        [
          u.firstName,
          u.lastName,
        ]
          .filter(Boolean)
          .join(' ') ||
          'Telegram'
      );

    const expiry =
      license?.expiresAt
        ? new Date(
            license.expiresAt *
            1000
          ).toLocaleString(
            'ru-RU'
          )
        : '—';

    return sendText(
      config,
      userId,
      `<b>👤 Мой аккаунт</b>\n\n<b>${full}</b>${
        u.username
          ? `\n@${escapeHtml(
              u.username
            )}`
          : ''
      }\n\nТариф: <b>${
        license
          ? currentPlan(
              license
            ) === 'pro'
              ? 'Pro'
              : 'Standard'
          : 'нет подписки'
      }</b>\nДо: <b>${expiry}</b>\n\nПри установке X-Tablet можно войти через этот Telegram-аккаунт — имя и срок подписки подтянутся автоматически.`,
      mainKeyboard()
    );
  }

  if (
    command ===
    '/subscription'
  ) {
    const license =
      findUserLicense(
        store,
        userId
      );

    if (
      !license ||
      !isActive(license)
    ) {
      return sendText(
        config,
        userId,
        '🔴 Активной подписки нет.',
        planKeyboard()
      );
    }

    await sendText(
      config,
      userId,
      `👤 <b>Моя подписка</b>\n\nТариф: ${
        currentPlan(
          license
        ) === 'pro'
          ? 'Pro'
          : 'Standard'
      }\nДо: ${new Date(
        license.expiresAt *
        1000
      ).toLocaleString(
        'ru-RU'
      )}\nУстройство: ${
        license.deviceId
          ? 'привязано'
          : 'не активировано'
      }`,
      mainKeyboard()
    );

    return;
  }

  if (
    command === '/device'
  ) {
    const license =
      findUserLicense(
        store,
        userId
      );

    await sendText(
      config,
      userId,
      license?.deviceId
        ? `📱 Устройство:\n<code>${license.deviceId}</code>\n\nДля переноса используйте /resetdevice.`
        : '📱 Устройство ещё не активировано.',
      mainKeyboard()
    );

    return;
  }

  if (
    command ===
    '/resetdevice'
  ) {
    const license =
      findUserLicense(
        store,
        userId
      );

    if (!license) {
      return sendText(
        config,
        userId,
        'Активной лицензии нет.',
        mainKeyboard()
      );
    }

    if (
      license.resetAt &&
      now() -
        license.resetAt <
        RESET_COOLDOWN
    ) {
      const left =
        RESET_COOLDOWN -
        (
          now() -
          license.resetAt
        );

      return sendText(
        config,
        userId,
        `⏱ Повторный сброс устройства будет доступен примерно через ${Math.ceil(
          left / DAY
        )} дн.`,
        mainKeyboard()
      );
    }

    license.deviceId =
      null;

    license.deviceSecretHash =
      null;

    license.resetAt =
      now();

    license.updatedAt =
      iso();

    saveStore(store);

    return sendText(
      config,
      userId,
      '✅ Устройство отвязано. Следующая активация ключа привяжет новый ПК.',
      mainKeyboard()
    );
  }

  if (
    command === '/terms'
  ) {
    return sendText(
      config,
      userId,
      `<b>📄 Условия X-Tablet</b>\n\nX-Tablet — цифровой companion для X-Plane 12. Оплата цифровой подписки проходит через Telegram Stars. После успешного платежа пользователь получает лицензию на выбранный период. Лицензия Standard/Pro привязывается к одному ПК; перенос выполняется через /resetdevice по правилам продукта.\n\nПоддержка: /support\nПлатёжные вопросы: /paysupport\nПолитика конфиденциальности: /privacy`,
      mainKeyboard()
    );
  }

  if (
    command === '/privacy'
  ) {
    return sendText(
      config,
      userId,
      `<b>🔒 Конфиденциальность</b>\n\nДля работы магазина мы обрабатываем минимальный набор данных, который приходит от Telegram: Telegram ID, публичный username/имя, сведения о покупке и лицензии, а также технический Device ID для привязки лицензии. Данные используются только для оплаты, выдачи лицензии, скачивания, поддержки и защиты от повторной активации.\n\nЗапрос на удаление данных можно отправить через /support.`,
      mainKeyboard()
    );
  }

  if (
    command ===
    '/paysupport'
  ) {
    return sendText(
      config,
      userId,
      '<b>💳 Поддержка платежей</b>\n\nНапиши проблему одним сообщением и укажи, какой тариф покупал.\n\nМы сверим Telegram payment ID и состояние подписки.'
    );
  }

  if (
    command === '/support'
  ) {
    return sendText(
      config,
      userId,
      '<b>🆘 Поддержка X-Tablet</b>\n\nНапиши проблему следующим сообщением.\n\nПример: «X-Plane найден, но телефон не подключается».'
    );
  }

  if (
    text &&
    !text.startsWith('/')
  ) {
    const ticketId =
      `T-${randomHex(6).toUpperCase()}`;

    store.supportTickets[
      ticketId
    ] = {
      id:
        ticketId,
      telegramUserId:
        String(userId),
      username:
        message.from
          ?.username || '',
      message:
        text,
      createdAt:
        iso(),
    };

    saveStore(store);

    audit(
      store,
      'support_ticket_created',
      String(userId),
      { ticketId }
    );

    if (
      config.adminTelegramId
    ) {
      await sendText(
        config,
        config.adminTelegramId,
        `<b>🆘 Новый тикет ${ticketId}</b>\n\nUser: <code>${userId}</code>\n@${escapeHtml(
          message.from
            ?.username ||
          '—'
        )}\n\n${escapeHtml(
          text
        )}`
      );
    }

    await sendText(
      config,
      userId,
      '✅ Сообщение отправлено в поддержку.\n\nНомер тикета: <code>' +
        ticketId +
        '</code>',
      mainKeyboard()
    );
  }
}

/*
 * Telegram Webhook
 *
 * ВАЖНО:
 * Здесь больше НЕТ deleteWebhook()
 * и НЕТ getUpdates().
 */
async function prepareBot(
  config
) {
  await telegram(
    'setMyCommands',
    {
      commands: [
        {
          command: 'start',
          description:
            'Открыть X-Tablet',
        },
        {
          command: 'buy',
          description:
            'Купить подписку',
        },
        {
          command:
            'subscription',
          description:
            'Моя подписка',
        },
        {
          command:
            'account',
          description:
            'Мой Telegram аккаунт',
        },
        {
          command:
            'license',
          description:
            'Моя лицензия',
        },
        {
          command:
            'device',
          description:
            'Моё устройство',
        },
        {
          command:
            'download',
          description:
            'Мои файлы',
        },
        {
          command:
            'resetdevice',
          description:
            'Перенести устройство',
        },
        {
          command:
            'support',
          description:
            'Техническая поддержка',
        },
        {
          command:
            'paysupport',
          description:
            'Поддержка оплаты',
        },
        {
          command:
            'terms',
          description:
            'Условия использования',
        },
        {
          command:
            'privacy',
          description:
            'Конфиденциальность',
        },
      ],
    },
    config
  );

  const me =
    await telegram(
      'getMe',
      {},
      config
    );

  console.log(
    `[telegram] connected as @${me.username || me.first_name}`
  );

  const webhookUrl =
    `${config.publicApiUrl.replace(/\/$/, '')}/telegram/webhook`;

  const secret =
    telegramWebhookSecret(
      config
    );

  await telegram(
    'setWebhook',
    {
      url: webhookUrl,
      secret_token:
        secret,
      allowed_updates: [
        'message',
        'callback_query',
        'pre_checkout_query',
      ],
      drop_pending_updates:
        false,
    },
    config
  );

  console.log(
    `[telegram] webhook enabled: ${webhookUrl}`
  );
}

/*
 * Старый polling оставлен как функция
 * только для совместимости/тестов.
 *
 * НИГДЕ НЕ ВЫЗЫВАЕТСЯ.
 */
async function runPolling(
  config,
  store,
  keys
) {
  console.warn(
    '[telegram] runPolling() is disabled. Webhook mode is active.'
  );

  return;
}

function json(
  res,
  status,
  value,
  extraHeaders = {}
) {
  res.writeHead(
    status,
    {
      'content-type':
        'application/json; charset=utf-8',
      'cache-control':
        'no-store',
      ...extraHeaders,
    }
  );

  res.end(
    JSON.stringify(value)
  );
}

async function readJson(req) {
  const chunks = [];

  for await (
    const chunk of req
  ) {
    chunks.push(chunk);
  }

  const raw =
    Buffer.concat(chunks)
      .toString('utf8');

  if (
    Buffer.byteLength(raw) >
    256 * 1024
  ) {
    throw new Error(
      'request_too_large'
    );
  }

  return raw
    ? JSON.parse(raw)
    : {};
}

function cors(
  req,
  res,
  config
) {
  const origin =
    String(
      req.headers.origin || ''
    );

  const allowed =
    new Set([
      String(
        config.publicSiteUrl ||
        ''
      ).replace(
        /\/$/,
        ''
      ),
    ]);

  if (
    origin &&
    allowed.has(origin)
  ) {
    res.setHeader(
      'Access-Control-Allow-Origin',
      origin
    );
  }

  res.setHeader(
    'Vary',
    'Origin'
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );
}

async function streamLocalFile(
  res,
  filePath,
  downloadName
) {
  const absolute =
    path.resolve(filePath);

  if (
    !absolute.startsWith(
      path.resolve(
        DOWNLOAD_DIR
      ) + path.sep
    )
  ) {
    throw new Error(
      'invalid_file'
    );
  }

  const stat =
    fs.statSync(absolute);

  const ext =
    path.extname(
      downloadName
    ).toLowerCase();

  const mime =
    ext === '.exe'
      ? 'application/vnd.microsoft.portable-executable'
      : ext === '.dmg'
        ? 'application/x-apple-diskimage'
        : ext === '.zip'
          ? 'application/zip'
          : ext === '.gz' ||
              ext === '.tgz'
            ? 'application/gzip'
            : 'application/octet-stream';

  res.writeHead(
    200,
    {
      'content-type':
        mime,
      'content-length':
        stat.size,
      'content-disposition':
        `attachment; filename="${downloadName.replaceAll('"', '')}"`,
      'cache-control':
        'private, no-store',
      'x-content-type-options':
        'nosniff',
    }
  );

  Readable
    .from(
      fs.createReadStream(
        absolute
      )
    )
    .pipe(res);
}

function siteSession(
  store,
  config,
  sessionToken
) {
  const session =
    store.purchaseSessions[
      String(
        sessionToken || ''
      )
    ];

  if (
    !session ||
    session.expiresAt <=
      now()
  ) {
    return null;
  }

  const license =
    store.licenses[
      session.licenseId
    ];

  if (
    !license ||
    !isActive(license)
  ) {
    return null;
  }

  const output = {
    plan:
      currentPlan(
        license
      ),
    licenseKey:
      license.licenseKey,
    expiresAt:
      license.expiresAt,
    companionSlots:
      planOf(
        license.plan
      ).companionSlots,
    entitlements:
      planEntitlements(
        license.plan
      ),
    files: {},
  };

  for (
    const platform of [
      'windows',
      'linux',
      'macos',
    ]
  ) {
    if (
      safeFileName(
        config,
        platform
      )
    ) {
      const token =
        createDownloadToken(
          store,
          license.id,
          license.telegramUserId,
          platform
        );

      output.files[
        platform
      ] =
        `${config.publicApiUrl.replace(/\/$/, '')}/download/${token}`;
    }
  }

  saveStore(store);

  return output;
}

function activationRateLimited(
  ip
) {
  const key =
    String(
      ip || 'unknown'
    );

  const stamp =
    now();

  const item =
    activationAttempts.get(
      key
    );

  if (
    !item ||
    stamp -
      item.startedAt >=
      ACTIVATION_WINDOW
  ) {
    activationAttempts.set(
      key,
      {
        startedAt:
          stamp,
        count: 1,
      }
    );

    return false;
  }

  item.count += 1;

  return (
    item.count >
    ACTIVATION_LIMIT
  );
}

function activateLicense(
  store,
  keys,
  body
) {
  const license =
    findLicense(
      store,
      body.licenseKey
    );

  if (
    !license ||
    !isActive(license)
  ) {
    return {
      status: 403,
      body: {
        error:
          'license_invalid',
      },
    };
  }

  const deviceId =
    String(
      body.deviceId || ''
    ).trim();

  const deviceSecret =
    String(
      body.deviceSecret || ''
    ).trim();

  if (
    !deviceId ||
    deviceId.length < 12 ||
    !deviceSecret ||
    deviceSecret.length < 32
  ) {
    return {
      status: 400,
      body: {
        error:
          'device_credentials_required',
      },
    };
  }

  if (
    !license.deviceId
  ) {
    license.deviceId =
      deviceId;

    license.deviceSecretHash =
      hashSecret(
        deviceSecret
      );

    license.updatedAt =
      iso();
  } else if (
    license.deviceId !==
    deviceId
  ) {
    return {
      status: 409,
      body: {
        error:
          'device_already_bound',
      },
    };
  } else if (
    license.deviceSecretHash !==
    hashSecret(
      deviceSecret
    )
  ) {
    return {
      status: 401,
      body: {
        error:
          'device_secret_invalid',
      },
    };
  }

  const token =
    issueActivationToken(
      license,
      deviceId,
      keys
    );

  return {
    status: 200,
    body: {
      token,
      public:
        publicLicense(
          license
        ),
      serverTime:
        now(),
    },
  };
}

/*
 * Бесплатная загрузка мода
 *
 * Файл:
 * server/downloads/X-Tablet-Free.zip
 *
 * Доступна только авторизованной админке.
 */
async function adminFreeDownload(
  req,
  res
) {
  const fileName =
    'X-Tablet-Free.zip';

  const filePath =
    path.join(
      DOWNLOAD_DIR,
      fileName
    );

  /*
   * Если локальный файл существует —
   * используем его.
   *
   * Это сохраняет твою текущую
   * админскую возможность.
   */
  if (
    fs.existsSync(
      filePath
    )
  ) {
    return streamLocalFile(
      res,
      filePath,
      fileName
    );
  }

  /*
   * Если файла на сервере нет —
   * берём последнюю сборку
   * из GitHub Releases.
   */
  return redirectRelease(
    res,
    fileName
  );
}

async function main() {
  const config =
    loadConfig();

  const keys =
    ensureEd25519Keys();

  const store =
    loadStore();

  const server =
    http.createServer(
      async (
        req,
        res
      ) => {
        cors(
          req,
          res,
          config
        );

        if (
          req.method ===
          'OPTIONS'
        ) {
          res.writeHead(204);
          return res.end();
        }

        try {
          const url =
            new URL(
              req.url,
              `http://${req.headers.host}`
            );

          /*
           * TELEGRAM WEBHOOK
           */
          if (
            req.method ===
              'POST' &&
            url.pathname ===
              '/telegram/webhook'
          ) {
            const expectedSecret =
              telegramWebhookSecret(
                config
              );

            const receivedSecret =
              String(
                req.headers[
                  'x-telegram-bot-api-secret-token'
                ] || ''
              );

            if (
              receivedSecret !==
              expectedSecret
            ) {
              console.warn(
                '[telegram webhook] invalid secret'
              );

              return json(
                res,
                403,
                {
                  error:
                    'webhook_forbidden',
                }
              );
            }

            const update =
              await readJson(
                req
              );

            console.log(
              `[telegram webhook] update ${update?.update_id ?? 'unknown'}`
            );

            try {
              await handleTelegramUpdate(
                config,
                store,
                keys,
                update
              );
            } catch (error) {
              console.error(
                '[telegram webhook update]',
                error
              );
            }

            return json(
              res,
              200,
              {
                ok: true,
              }
            );
          }

          /*
           * ADMIN PANEL
           */
          if (
            url.pathname ===
              '/admin.html' &&
            req.method ===
              'GET'
          ) {
            const adminPath =
              path.join(
                ROOT,
                'admin.html'
              );

            if (
              !fs.existsSync(
                adminPath
              )
            ) {
              return json(
                res,
                404,
                {
                  error:
                    'admin_not_installed',
                }
              );
            }

            res.writeHead(
              200,
              {
                'content-type':
                  'text/html; charset=utf-8',
                'cache-control':
                  'no-store',
                'x-content-type-options':
                  'nosniff',
                'x-frame-options':
                  'DENY',
                'referrer-policy':
                  'no-referrer',
              }
            );

            return res.end(
              fs.readFileSync(
                adminPath
              )
            );
          }

          /*
           * ADMIN API
           */
          if (
            url.pathname.startsWith(
              '/v1/admin/'
            )
          ) {
            if (
              !adminAuthorized(
                req,
                config
              )
            ) {
              return json(
                res,
                401,
                {
                  error:
                    'admin_unauthorized',
                }
              );
            }

            if (
              req.method ===
                'GET' &&
              url.pathname ===
                '/v1/admin/overview'
            ) {
              return json(
                res,
                200,
                adminData(
                  store
                )
              );
            }

            /*
             * Бесплатное скачивание
             */
            if (
              req.method ===
                'GET' &&
              url.pathname ===
                '/v1/admin/free-download'
            ) {
              return adminFreeDownload(
                req,
                res
              );
            }

            if (
              req.method ===
                'POST' &&
              url.pathname ===
                '/v1/admin/privacy/delete'
            ) {
              const body =
                await readJson(
                  req
                );

              const id =
                String(
                  body.telegramUserId ||
                    ''
                ).trim();

              if (
                !/^\d+$/.test(
                  id
                )
              ) {
                return json(
                  res,
                  400,
                  {
                    error:
                      'invalid_telegram_user_id',
                  }
                );
              }

              privacyDelete(
                store,
                id
              );

              return json(
                res,
                200,
                {
                  ok: true,
                }
              );
            }

            return json(
              res,
              404,
              {
                error:
                  'admin_not_found',
              }
            );
          }

          /*
           * HEALTH
           */
          if (
            req.method ===
              'GET' &&
            url.pathname ===
              '/health'
          ) {
            return json(
              res,
              200,
              {
                ok: true,
                product:
                  'x-tablet',
                time:
                  now(),
              }
            );
          }

          /*
           * PUBLIC CONFIG
           */
          if (
            req.method ===
              'GET' &&
            url.pathname ===
              '/v1/public-config'
          ) {
            return json(
              res,
              200,
              {
                ok: true,
                publicKey:
                  keys.publicRawB64,
                version: 1,
              }
            );
          }

          /*
           * SITE SESSION
           */
          if (
            req.method ===
              'GET' &&
            url.pathname.startsWith(
              '/v1/site/session/'
            )
          ) {
            const token =
              url.pathname.slice(
                '/v1/site/session/'
                  .length
              );

            const result =
              siteSession(
                store,
                config,
                token
              );

            if (!result) {
              return json(
                res,
                401,
                {
                  error:
                    'session_invalid_or_expired',
                }
              );
            }

            return json(
              res,
              200,
              result
            );
          }

          /*
           * DEVICE LINK START
           */
          if (
            req.method ===
              'POST' &&
            url.pathname ===
              '/v1/device/link/start'
          ) {
            const body =
              await readJson(
                req
              );

            const deviceId =
              String(
                body.deviceId ||
                  ''
              ).trim();

            if (
              !/^XT-[A-F0-9]{20}$/.test(
                deviceId
              )
            ) {
              return json(
                res,
                400,
                {
                  error:
                    'device_id_invalid',
                }
              );
            }

            const code =
              createDeviceLink(
                store,
                deviceId
              );

            saveStore(
              store
            );

            return json(
              res,
              200,
              {
                code,
                botUrl:
                  `${config.telegramBotUrl}?start=link_${encodeURIComponent(code)}`,
                expiresAt:
                  store.deviceLinks[
                    code
                  ].expiresAt,
              }
            );
          }

          /*
           * DEVICE LINK STATUS
           */
          if (
            req.method ===
              'GET' &&
            url.pathname.startsWith(
              '/v1/device/link/status/'
            )
          ) {
            const code =
              url.pathname.slice(
                '/v1/device/link/status/'
                  .length
              );

            const entry =
              findDeviceLink(
                store,
                code
              );

            if (!entry) {
              return json(
                res,
                410,
                {
                  error:
                    'link_expired',
                }
              );
            }

            if (
              !entry.telegramUserId
            ) {
              return json(
                res,
                200,
                {
                  status:
                    'waiting',
                }
              );
            }

            return json(
              res,
              200,
              {
                status:
                  'linked',
                profile:
                  userProfile(
                    store,
                    entry.telegramUserId
                  ),
                deviceId:
                  entry.deviceId,
              }
            );
          }

          /*
           * DEVICE LINK CLAIM
           */
          if (
            req.method ===
              'POST' &&
            url.pathname ===
              '/v1/device/link/claim'
          ) {
            const body =
              await readJson(
                req
              );

            const deviceId =
              String(
                body.deviceId ||
                  ''
              ).trim();

            const code =
              String(
                body.code ||
                  ''
              ).trim();

            const entry =
              findDeviceLink(
                store,
                code
              );

            if (
              !entry ||
              entry.deviceId !==
                deviceId ||
              !entry.telegramUserId
            ) {
              return json(
                res,
                403,
                {
                  error:
                    'link_invalid',
                }
              );
            }

            const license =
              findUserLicense(
                store,
                entry.telegramUserId
              );

            if (
              !license ||
              !isActive(license)
            ) {
              return json(
                res,
                403,
                {
                  error:
                    'license_inactive',
                }
              );
            }

            const deviceSecret =
              String(
                body.deviceSecret ||
                  ''
              );

            if (
              deviceSecret.length <
              32
            ) {
              return json(
                res,
                400,
                {
                  error:
                    'device_secret_required',
                }
              );
            }

            if (
              license.deviceId &&
              license.deviceId !==
                deviceId
            ) {
              return json(
                res,
                409,
                {
                  error:
                    'device_already_bound',
                }
              );
            }

            if (
              license.deviceId ===
                deviceId &&
              license.deviceSecretHash &&
              license.deviceSecretHash !==
                hashSecret(
                  deviceSecret
                )
            ) {
              return json(
                res,
                401,
                {
                  error:
                    'device_secret_invalid',
                }
              );
            }

            if (
              !license.deviceId
            ) {
              license.deviceId =
                deviceId;

              license.deviceSecretHash =
                hashSecret(
                  deviceSecret
                );

              license.updatedAt =
                iso();
            }

            audit(
              store,
              'device_claimed_via_telegram',
              String(
                entry.telegramUserId
              ),
              {
                deviceId,
                licenseId:
                  license.id,
              }
            );

            delete store.deviceLinks[
              code
            ];

            saveStore(
              store
            );

            return json(
              res,
              200,
              {
                token:
                  issueActivationToken(
                    license,
                    deviceId,
                    keys
                  ),
                public:
                  publicLicense(
                    license
                  ),
                profile:
                  userProfile(
                    store,
                    entry.telegramUserId
                  ),
              }
            );
          }

          /*
           * LICENSE ACTIVATE
           */
          if (
            req.method ===
              'POST' &&
            url.pathname ===
              '/v1/license/activate'
          ) {
            if (
              activationRateLimited(
                req.socket
                  .remoteAddress
              )
            ) {
              return json(
                res,
                429,
                {
                  error:
                    'too_many_attempts',
                }
              );
            }

            const body =
              await readJson(
                req
              );

            const result =
              activateLicense(
                store,
                keys,
                body
              );

            if (
              result.status ===
              200
            ) {
              saveStore(
                store
              );
            }

            return json(
              res,
              result.status,
              result.body
            );
          }

          /*
           * LICENSE HEARTBEAT
           */
          if (
            req.method ===
              'POST' &&
            url.pathname ===
              '/v1/license/heartbeat'
          ) {
            const body =
              await readJson(
                req
              );

            const payload =
              verifyToken(
                body.token,
                keys
              );

            if (!payload) {
              return json(
                res,
                401,
                {
                  error:
                    'token_invalid',
                }
              );
            }

            const license =
              store.licenses[
                payload.licenseId
              ];

            if (
              !license ||
              !isActive(
                license
              ) ||
              license.deviceId !==
                body.deviceId
            ) {
              return json(
                res,
                403,
                {
                  error:
                    'license_denied',
                }
              );
            }

            if (
              license.deviceSecretHash &&
              license.deviceSecretHash !==
                hashSecret(
                  String(
                    body.deviceSecret ||
                      ''
                  )
                )
            ) {
              return json(
                res,
                401,
                {
                  error:
                    'device_secret_invalid',
                }
              );
            }

            return json(
              res,
              200,
              {
                token:
                  issueActivationToken(
                    license,
                    license.deviceId,
                    keys
                  ),
                public:
                  publicLicense(
                    license
                  ),
                serverTime:
                  now(),
              }
            );
          }

          /*
           * USER DOWNLOAD
           */
          if (
            req.method ===
              'GET' &&
            url.pathname.startsWith(
              '/download/'
            )
          ) {
            const token =
              url.pathname.slice(
                '/download/'.length
              );

            const entry =
              store.downloadTokens[
                token
              ];

            if (
              !entry ||
              entry.expiresAt <=
                now()
            ) {
              return json(
                res,
                410,
                {
                  error:
                    'download_expired',
                }
              );
            }

            const license =
              store.licenses[
                entry.licenseId
              ];

            if (
              !license ||
              !isActive(
                license
              ) ||
              String(
                license.telegramUserId
              ) !==
                String(
                  entry.telegramUserId
                )
            ) {
              return json(
                res,
                403,
                {
                  error:
                    'download_denied',
                }
              );
            }

            const fileName =
              safeFileName(
                config,
                entry.platform
              );

            if (!fileName) {
              return json(
                res,
                404,
                {
                  error:
                    'platform_unavailable',
                }
              );
            }

            const filePath =
              path.join(
                DOWNLOAD_DIR,
                fileName
              );

         if (!fs.existsSync(filePath)) {
  return redirectRelease(
    res,
    fileName
  );
}
            const uses =
              Number(
                entry.uses || 0
              );

            const maxUses =
              Number(
                entry.maxUses ||
                  DOWNLOAD_MAX_USES
              );

            if (
              uses >=
              maxUses
            ) {
              return json(
                res,
                410,
                {
                  error:
                    'download_token_used',
                }
              );
            }

            entry.uses =
              uses + 1;

            entry.lastUsedAt =
              iso();

            saveStore(
              store
            );

            return streamLocalFile(
              res,
              filePath,
              fileName
            );
          }

          /*
           * ROOT
           */
          if (
            req.method ===
              'GET' &&
            url.pathname ===
              '/'
          ) {
            res.writeHead(
              200,
              {
                'content-type':
                  'text/plain; charset=utf-8',
              }
            );

            return res.end(
              'X-Tablet License Server'
            );
          }

          return json(
            res,
            404,
            {
              error:
                'not_found',
            }
          );
        } catch (error) {
          console.error(
            '[http]',
            error
          );

          return json(
            res,
            500,
            {
              error:
                'server_error',
            }
          );
        }
      }
    );

  const listen =
    String(
      config.listen ||
        '127.0.0.1:8788'
    );

  const [
    host,
    portRaw,
  ] = listen.split(':');

  const port =
    Number(
      portRaw || 8788
    );

  server.listen(
    port,
    host,
    () => {
      console.log(
        `X-Tablet server listening on http://${host}:${port}`
      );

      console.log(
        `Public key: ${keys.publicRawB64}`
      );
    }
  );

  await prepareBot(
    config
  );

  /*
   * ВАЖНО:
   * polling больше НЕ запускаем.
   *
   * Было:
   * await runPolling(config, store, keys);
   *
   * Теперь webhook.
   */
}

if (
  import.meta.url ===
  `file://${process.argv[1]}`
) {
  main().catch(
    error => {
      console.error(
        error
      );

      process.exit(1);
    }
  );
}

export {
  DEFAULT_PLANS,
  MONTH,
  generateLicenseKey,
  hashSecret,
  issueActivationToken,
  verifyToken,
  activationRateLimited,
  upsertLicenseAfterPayment,
  findLicense,
  isActive,
  activateLicense,
  siteSession,
  expectedStars,
  hasActiveSubscription,
  rememberTelegramUser,
  adminSummary,
  adminData,
  privacyDelete,
  audit,
  createDeviceLink,
  findDeviceLink,
  userProfile,
};
