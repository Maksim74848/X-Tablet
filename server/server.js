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
const KEYS_DIR = path.join(ROOT, 'keys');

const RELEASE_BASE_URL =
  'https://github.com/Maksim74848/X-Tablet/releases/latest/download';

const DAY = 86400;
const MONTH = 30 * DAY;

const SITE_SESSION_TTL = 20 * 60;
const DOWNLOAD_TTL = 30 * 60;
const DOWNLOAD_MAX_USES = 3;

const DEVICE_LINK_TTL = 10 * 60;
const RESET_COOLDOWN = 30 * DAY;

const ACTIVATION_WINDOW = 60;
const ACTIVATION_LIMIT = 8;

const activationAttempts = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
fs.mkdirSync(KEYS_DIR, { recursive: true });

const now = () =>
  Math.floor(Date.now() / 1000);

const iso = () =>
  new Date().toISOString();

const randomHex = (bytes = 24) =>
  crypto.randomBytes(bytes).toString('hex');

const b64u = value =>
  Buffer.from(value).toString('base64url');

const fromB64u = value =>
  Buffer.from(value, 'base64url');

/* =========================================================
 * CONFIG
 * ======================================================= */

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(
      'server/config.json не найден'
    );
  }

  const config = JSON.parse(
    fs.readFileSync(
      CONFIG_FILE,
      'utf8'
    )
  );

  if (
    !config.botToken ||
    config.botToken.startsWith('PASTE_')
  ) {
    throw new Error(
      'botToken не настроен'
    );
  }

  if (
    !config.publicSiteUrl ||
    config.publicSiteUrl.includes('YOUR_')
  ) {
    throw new Error(
      'publicSiteUrl не настроен'
    );
  }

  if (
    !config.publicApiUrl ||
    config.publicApiUrl.includes('YOUR_')
  ) {
    throw new Error(
      'publicApiUrl не настроен'
    );
  }

  if (
    !config.telegramBotUrl ||
    !/^https:\/\/t\.me\/[^\s]+$/.test(
      config.telegramBotUrl
    )
  ) {
    throw new Error(
      'telegramBotUrl не настроен'
    );
  }

  if (
    !config.adminToken ||
    config.adminToken.startsWith('PASTE_') ||
    config.adminToken.length < 24
  ) {
    throw new Error(
      'adminToken не настроен'
    );
  }

  return config;
}

/* =========================================================
 * STORE
 * ======================================================= */

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
        fs.readFileSync(
          STORE_FILE,
          'utf8'
        )
      ),
    };
  } catch (error) {
    throw new Error(
      `store.json повреждён: ${error.message}`
    );
  }
}

function saveStore(store) {
  const tmp =
    `${STORE_FILE}.tmp`;

  fs.writeFileSync(
    tmp,
    JSON.stringify(
      store,
      null,
      2
    ),
    {
      mode: 0o600,
    }
  );

  fs.renameSync(
    tmp,
    STORE_FILE
  );
}

/* =========================================================
 * PLANS
 * ======================================================= */

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
    planOf(name)
      .entitlements
      .map(
        item => [
          item,
          true,
        ]
      )
  );
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
    Number(
      license.expiresAt || 0
    ) > now()
  );
}

/* =========================================================
 * KEYS / TOKENS
 * ======================================================= */

function ensureEd25519Keys() {
  const privatePath =
    path.join(
      KEYS_DIR,
      'private.pem'
    );

  const publicPath =
    path.join(
      KEYS_DIR,
      'public.pem'
    );

  if (
    !fs.existsSync(privatePath) ||
    !fs.existsSync(publicPath)
  ) {
    const pair =
      crypto.generateKeyPairSync(
        'ed25519'
      );

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
      fs.readFileSync(
        privatePath,
        'utf8'
      )
    );

  const publicKey =
    crypto.createPublicKey(
      fs.readFileSync(
        publicPath,
        'utf8'
      )
    );

  const publicRawB64 =
    publicKey
      .export({
        type: 'spki',
        format: 'der',
      })
      .subarray(-32)
      .toString('base64');

  return {
    privateKey,
    publicKey,
    publicRawB64,
  };
}

function signToken(payload, keys) {
  const body =
    b64u(
      JSON.stringify(payload)
    );

  const signature =
    crypto.sign(
      null,
      Buffer.from(body),
      keys.privateKey
    );

  return (
    `${body}.${b64u(signature)}`
  );
}

function verifyToken(token, keys) {
  try {
    const [
      body,
      signature,
    ] =
      String(token || '')
        .split('.');

    if (
      !body ||
      !signature
    ) {
      return null;
    }

    const valid =
      crypto.verify(
        null,
        Buffer.from(body),
        keys.publicKey,
        fromB64u(signature)
      );

    if (!valid) {
      return null;
    }

    const payload =
      JSON.parse(
        fromB64u(body)
          .toString('utf8')
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
        planEntitlements(
          license.plan
        ),
    },
    keys
  );
}

/* =========================================================
 * LICENSES
 * ======================================================= */

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
    group++
  ) {
    let block = '';

    for (
      let i = 0;
      i < 5;
      i++
    ) {
      block +=
        chars[
          crypto.randomInt(
            chars.length
          )
        ];
    }

    output +=
      `-${block}`;
  }

  return output;
}

function hashSecret(secret) {
  return crypto
    .createHash('sha256')
    .update(
      String(secret)
    )
    .digest('hex');
}

function findLicense(
  store,
  licenseKey
) {
  const key =
    normalizeLicenseKey(
      licenseKey
    );

  return Object.values(
    store.licenses
  ).find(
    item =>
      item.licenseKey === key
  ) || null;
}

function findUserLicense(
  store,
  telegramUserId
) {
  return Object.values(
    store.licenses
  ).find(
    license =>
      String(
        license.telegramUserId
      ) ===
      String(
        telegramUserId
      )
  ) || null;
}

function publicLicense(license) {
  if (!license) {
    return null;
  }

  return {
    licenseId:
      license.id,

    licenseKey:
      license.licenseKey,

    plan:
      currentPlan(license),

    expiresAt:
      Number(
        license.expiresAt
      ),

    deviceBound:
      Boolean(
        license.deviceId
      ),

    companionSlots:
      planOf(
        license.plan
      ).companionSlots,

    entitlements:
      planEntitlements(
        license.plan
      ),
  };
}

function upsertLicenseAfterPayment(
  store,
  telegramUserId,
  plan,
  payment
) {
  const chargeId =
    payment
      .telegram_payment_charge_id;

  if (
    chargeId &&
    store.payments[chargeId]
  ) {
    const previous =
      store.payments[
        chargeId
      ];

    return {
      license:
        store.licenses[
          previous.licenseId
        ],
      duplicate: true,
    };
  }

  let license =
    findUserLicense(
      store,
      telegramUserId
    );

  const telegramExpiry =
    Number(
      payment
        .subscription_expiration_date ||
      0
    );

  const expiry =
    telegramExpiry ||
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
          license.expiresAt || 0
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
        Number(
          payment.total_amount
        ),

      currency:
        payment.currency,

      createdAt:
        iso(),
    };
  }

  return {
    license,
    duplicate: false,
  };
}

/* =========================================================
 * USERS
 * ======================================================= */

function rememberTelegramUser(
  store,
  user
) {
  if (!user?.id) {
    return;
  }

  const id =
    String(user.id);

  const previous =
    store.users[id] || {
      telegramUserId:
        id,
      createdAt:
        iso(),
    };

  store.users[id] = {
    telegramUserId:
      id,

    username:
      String(
        user.username ||
        previous.username ||
        ''
      ),

    firstName:
      String(
        user.first_name ||
        previous.firstName ||
        ''
      ),

    lastName:
      String(
        user.last_name ||
        previous.lastName ||
        ''
      ),

    languageCode:
      String(
        user.language_code ||
        previous.languageCode ||
        ''
      ),

    isPremium:
      Boolean(
        user.is_premium ??
        previous.isPremium ??
        false
      ),

    termsAcceptedAt:
      previous.termsAcceptedAt ||
      null,

    createdAt:
      previous.createdAt ||
      iso(),

    updatedAt:
      iso(),
  };
}

function userProfile(
  store,
  telegramUserId
) {
  const user =
    store.users[
      String(
        telegramUserId
      )
    ] || {};

  const license =
    findUserLicense(
      store,
      telegramUserId
    );

  return {
    telegramUserId:
      String(
        telegramUserId
      ),

    firstName:
      user.firstName || '',

    lastName:
      user.lastName || '',

    username:
      user.username || '',

    languageCode:
      user.languageCode || '',

    isPremium:
      Boolean(
        user.isPremium
      ),

    plan:
      license
        ? currentPlan(
            license
          )
        : null,

    expiresAt:
      license
        ? Number(
            license.expiresAt || 0
          )
        : 0,

    licenseKey:
      license?.licenseKey ||
      null,

    active:
      Boolean(
        license &&
        isActive(license)
      ),

    deviceBound:
      Boolean(
        license?.deviceId
      ),

    deviceId:
      license?.deviceId ||
      null,
  };
}

/* =========================================================
 * AUDIT
 * ======================================================= */

function audit(
  store,
  action,
  telegramUserId,
  meta = {}
) {
  store.auditLog.push({
    id:
      `A-${randomHex(6).toUpperCase()}`,

    action,

    telegramUserId:
      telegramUserId
        ? String(
            telegramUserId
          )
        : null,

    meta,

    createdAt:
      iso(),
  });

  if (
    store.auditLog.length > 5000
  ) {
    store.auditLog =
      store.auditLog.slice(
        -5000
      );
  }
}

/* =========================================================
 * DOWNLOADS
 * ======================================================= */

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
      String(
        telegramUserId
      ),

    platform,

    expiresAt:
      now() + DOWNLOAD_TTL,

    uses: 0,

    maxUses:
      DOWNLOAD_MAX_USES,

    createdAt:
      iso(),
  };

  return token;
}

function releaseUrl(
  fileName
) {
  return (
    `${RELEASE_BASE_URL}/` +
    encodeURIComponent(
      fileName
    )
  );
}

async function proxyRemoteRelease(
  res,
  fileName
) {
  const response =
    await fetch(
      releaseUrl(
        fileName
      )
    );

  if (
    !response.ok
  ) {
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

  const headers = {
    'content-type':
      response.headers.get(
        'content-type'
      ) ||
      'application/octet-stream',

    'content-disposition':
      `attachment; filename="${fileName.replaceAll('"', '')}"`,

    'cache-control':
      'private, no-store',

    'x-content-type-options':
      'nosniff',
  };

  const length =
    response.headers.get(
      'content-length'
    );

  if (length) {
    headers[
      'content-length'
    ] = length;
  }

  res.writeHead(
    200,
    headers
  );

  if (!response.body) {
    return res.end();
  }

  return Readable
    .fromWeb(
      response.body
    )
    .pipe(res);
}

async function streamLocalFile(
  res,
  filePath,
  downloadName
) {
  const absolute =
    path.resolve(
      filePath
    );

  const downloadsRoot =
    path.resolve(
      DOWNLOAD_DIR
    );

  if (
    !absolute.startsWith(
      downloadsRoot +
      path.sep
    )
  ) {
    throw new Error(
      'invalid_file'
    );
  }

  const stat =
    fs.statSync(
      absolute
    );

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

  fs.createReadStream(
    absolute
  ).pipe(res);
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
      now() + SITE_SESSION_TTL,

    createdAt:
      iso(),
  };

  return token;
}

function buildSiteSessionUrl(
  config,
  token
) {
  return (
    `${config.publicSiteUrl.replace(/\/$/, '')}` +
    `/?session=${encodeURIComponent(token)}`
  );
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

  saveStore(store);

  return buildSiteSessionUrl(
    config,
    token
  );
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
    Number(
      session.expiresAt
    ) <= now()
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
    const fileName =
      safeFileName(
        config,
        platform
      );

    if (!fileName) {
      continue;
    }

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

  saveStore(store);

  return output;
}

/* =========================================================
 * DEVICES
 * ======================================================= */

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

    telegramUserId:
      null,

    expiresAt:
      now() + DEVICE_LINK_TTL,

    createdAt:
      iso(),

    consumedAt:
      null,
  };

  return code;
}

function findDeviceLink(
  store,
  code
) {
  const key =
    String(
      code || ''
    );

  const entry =
    store.deviceLinks[
      key
    ];

  if (!entry) {
    return null;
  }

  if (
    Number(
      entry.expiresAt
    ) <= now()
  ) {
    delete store.deviceLinks[
      key
    ];

    saveStore(store);

    return null;
  }

  return entry;
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
    !/^XT-[A-F0-9]{20}$/.test(
      deviceId
    )
  ) {
    return {
      status: 400,
      body: {
        error:
          'device_id_invalid',
      },
    };
  }

  if (
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

  const secretHash =
    hashSecret(
      deviceSecret
    );

  if (
    !license.deviceId
  ) {
    license.deviceId =
      deviceId;

    license.deviceSecretHash =
      secretHash;

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
    secretHash
  ) {
    return {
      status: 401,
      body: {
        error:
          'device_secret_invalid',
      },
    };
  }

  return {
    status: 200,

    body: {
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

      serverTime:
        now(),
    },
  };
}

/* =========================================================
 * DEVICE TELEGRAM LINK
 * ======================================================= */

function startDeviceLink(
  store,
  config,
  deviceId
) {
  if (
    !/^XT-[A-F0-9]{20}$/.test(
      deviceId
    )
  ) {
    return null;
  }

  const code =
    createDeviceLink(
      store,
      deviceId
    );

  saveStore(store);

  return {
    code,

    botUrl:
      `${config.telegramBotUrl}` +
      `?start=link_${encodeURIComponent(code)}`,

    expiresAt:
      store.deviceLinks[
        code
      ].expiresAt,
  };
}

function claimDeviceLink(
  store,
  keys,
  body
) {
  const code =
    String(
      body.code || ''
    ).trim();

  const deviceId =
    String(
      body.deviceId || ''
    ).trim();

  const deviceSecret =
    String(
      body.deviceSecret || ''
    ).trim();

  const entry =
    findDeviceLink(
      store,
      code
    );

  if (
    !entry ||
    entry.deviceId !== deviceId ||
    !entry.telegramUserId
  ) {
    return {
      status: 403,
      body: {
        error:
          'link_invalid',
      },
    };
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
    return {
      status: 403,
      body: {
        error:
          'license_inactive',
      },
    };
  }

  if (
    deviceSecret.length < 32
  ) {
    return {
      status: 400,
      body: {
        error:
          'device_secret_required',
      },
    };
  }

  const secretHash =
    hashSecret(
      deviceSecret
    );

  if (
    license.deviceId &&
    license.deviceId !== deviceId
  ) {
    return {
      status: 409,
      body: {
        error:
          'device_already_bound',
      },
    };
  }

  if (
    license.deviceId === deviceId &&
    license.deviceSecretHash &&
    license.deviceSecretHash !==
      secretHash
  ) {
    return {
      status: 401,
      body: {
        error:
          'device_secret_invalid',
      },
    };
  }

  if (!license.deviceId) {
    license.deviceId =
      deviceId;

    license.deviceSecretHash =
      secretHash;

    license.updatedAt =
      iso();
  }

  delete store.deviceLinks[
    code
  ];

  audit(
    store,
    'device_claimed_via_telegram',
    entry.telegramUserId,
    {
      deviceId,
      licenseId:
        license.id,
    }
  );

  saveStore(store);

  return {
    status: 200,

    body: {
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
    },
  };
}

/* =========================================================
 * ADMIN
 * ======================================================= */

function adminAuthorized(
  req,
  config
) {
  const header =
    String(
      req.headers.authorization || ''
    );

  if (
    !header.startsWith(
      'Bearer '
    )
  ) {
    return false;
  }

  const supplied =
    Buffer.from(
      header.slice(7)
    );

  const expected =
    Buffer.from(
      String(
        config.adminToken
      )
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

function sanitizeAdminUser(
  store,
  telegramUserId
) {
  const user =
    store.users[
      String(
        telegramUserId
      )
    ] || {};

  const license =
    findUserLicense(
      store,
      telegramUserId
    );

  return {
    telegramUserId:
      String(
        telegramUserId
      ),

    username:
      user.username || '',

    firstName:
      user.firstName || '',

    lastName:
      user.lastName || '',

    languageCode:
      user.languageCode || '',

    isPremium:
      Boolean(
        user.isPremium
      ),

    createdAt:
      user.createdAt || null,

    updatedAt:
      user.updatedAt || null,

    license:
      license
        ? {
            ...publicLicense(
              license
            ),

            deviceId:
              license.deviceId ||
              null,
          }
        : null,
  };
}

function adminSummary(store) {
  const users =
    Object.values(
      store.users
    );

  const licenses =
    Object.values(
      store.licenses
    );

  const payments =
    Object.values(
      store.payments
    );

  return {
    users:
      users.length,

    licenses:
      licenses.length,

    activeLicenses:
      licenses.filter(
        isActive
      ).length,

    activeStandard:
      licenses.filter(
        item =>
          item.plan ===
            'standard' &&
          isActive(item)
      ).length,

    activePro:
      licenses.filter(
        item =>
          item.plan ===
            'pro' &&
          isActive(item)
      ).length,

    payments:
      payments.length,

    stars:
      payments.reduce(
        (sum, item) =>
          sum +
          Number(
            item.amount || 0
          ),
        0
      ),

    openSupport:
      Object.values(
        store.supportTickets
      ).filter(
        ticket =>
          ticket.status ===
          'open'
      ).length,
  };
}

function adminData(store) {
  const users =
    Object.keys(
      store.users
    )
      .map(
        id =>
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
        ([
          chargeId,
          payment,
        ]) => ({
          chargeId,

          telegramUserId:
            String(
              payment.telegramUserId
            ),

          username:
            store.users[
              String(
                payment.telegramUserId
              )
            ]?.username || '',

          plan:
            payment.plan,

          amount:
            payment.amount,

          currency:
            payment.currency,

          createdAt:
            payment.createdAt,
        })
      )
      .sort(
        (
          a,
          b
        ) =>
          String(
            b.createdAt
          ).localeCompare(
            String(
              a.createdAt
            )
          )
      );

  const licenses =
    Object.values(
      store.licenses
    )
      .map(
        license => ({
          ...publicLicense(
            license
          ),

          telegramUserId:
            String(
              license.telegramUserId
            ),

          username:
            store.users[
              String(
                license.telegramUserId
              )
            ]?.username || '',

          deviceId:
            license.deviceId ||
            null,

          status:
            license.status,
        })
      )
      .sort(
        (
          a,
          b
        ) =>
          Number(
            b.expiresAt
          ) -
          Number(
            a.expiresAt
          )
      );

  const tickets =
    Object.values(
      store.supportTickets
    )
      .sort(
        (
          a,
          b
        ) =>
          String(
            b.createdAt
          ).localeCompare(
            String(
              a.createdAt
            )
          )
      );

  return {
    summary:
      adminSummary(store),

    users,

    payments:
      payments.slice(
        0,
        100
      ),

    licenses,

    tickets:
      tickets.slice(
        0,
        100
      ),
  };
}

function privacyDelete(
  store,
  telegramUserId
) {
  const id =
    String(
      telegramUserId
    );

  delete store.users[id];

  for (
    const [
      licenseId,
      license,
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
      paymentId,
      payment,
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
        paymentId
      ];
    }
  }

  for (
    const [
      sessionId,
      session,
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
        sessionId
      ];
    }
  }

  for (
    const [
      token,
      entry,
    ] of Object.entries(
      store.downloadTokens
    )
  ) {
    if (
      String(
        entry.telegramUserId
      ) === id
    ) {
      delete store.downloadTokens[
        token
      ];
    }
  }

  for (
    const [
      code,
      entry,
    ] of Object.entries(
      store.deviceLinks
    )
  ) {
    if (
      String(
        entry.telegramUserId
      ) === id
    ) {
      delete store.deviceLinks[
        code
      ];
    }
  }

  store.auditLog =
    store.auditLog.filter(
      item =>
        String(
          item.telegramUserId
        ) !== id
    );

  saveStore(store);
}

/* =========================================================
 * TELEGRAM
 * ======================================================= */

async function telegram(
  method,
  body,
  config
) {
  const response =
    await fetch(
      `https://api.telegram.org/bot${config.botToken}/${method}`,
      {
        method: 'POST',

        headers: {
          'content-type':
            'application/json',
        },

        body:
          JSON.stringify(
            body
          ),
      }
    );

  const result =
    await response.json();

  if (!result.ok) {
    throw new Error(
      result.description ||
      `Telegram ${method} failed`
    );
  }

  return result.result;
}

function escapeHtml(value) {
  return String(
    value ?? ''
  )
    .replaceAll(
      '&',
      '&amp;'
    )
    .replaceAll(
      '<',
      '&lt;'
    )
    .replaceAll(
      '>',
      '&gt;'
    )
    .replaceAll(
      '"',
      '&quot;'
    );
}

async function sendText(
  config,
  chatId,
  text,
  replyMarkup = null
) {
  return telegram(
    'sendMessage',
    {
      chat_id:
        Number(chatId),

      text,

      parse_mode:
        'HTML',

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

async function answerCallback(
  config,
  callbackId,
  text = '',
  showAlert = false
) {
  return telegram(
    'answerCallbackQuery',
    {
      callback_query_id:
        callbackId,

      ...(text
        ? {
            text,
          }
        : {}),

      show_alert:
        showAlert,
    },
    config
  );
}

/* =========================================================
 * TELEGRAM BUTTONS
 * ======================================================= */

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text:
            '🛒 Купить',

          callback_data:
            'buy',
        },

        {
          text:
            '👤 Аккаунт',

          callback_data:
            'subscription',
        },
      ],

      [
        {
          text:
            '⬇️ Мои файлы',

          callback_data:
            'files',
        },

        {
          text:
            '📱 Устройство',

          callback_data:
            'device',
        },
      ],

      [
        {
          text:
            '🆘 Поддержка',

          callback_data:
            'support',
        },
      ],
    ],
  };
}

function planKeyboard() {
  return {
    inline_keyboard: [
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

      [
        {
          text:
            '◀️ Назад',

          callback_data:
            'home',
        },
      ],
    ],
  };
}

/* =========================================================
 * PAYMENT
 * ======================================================= */

function parsePayload(
  payload
) {
  const parts =
    String(
      payload || ''
    ).split(':');

  if (
    parts.length !== 4 ||
    parts[0] !== 'xt'
  ) {
    return null;
  }

  return {
    kind:
      parts[1],

    telegramUserId:
      parts[2],

    nonce:
      parts[3],
  };
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

      title:
        p.title,

      description:
        plan === 'pro'
          ? '30 дней X-Tablet Pro: один ПК, до 4 companion-устройств и расширенные функции.'
          : '30 дней X-Tablet Standard: один ПК, один companion-экран, live-данные, команды и диагностика.',

      payload,

      currency:
        'XTR',

      prices: [
        {
          label:
            p.title,

          amount:
            p.stars,
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
        'Тестовый цифровой товар.',

      payload,

      currency:
        'XTR',

      prices: [
        {
          label:
            'Hello World',

          amount:
            1,
        },
      ],

      start_parameter:
        'buy_hello_world',
    },
    config
  );
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

  const plan =
    currentPlan(
      license
    ) === 'pro'
      ? 'Pro'
      : 'Standard';

  await sendText(
    config,
    chatId,

    `✅ <b>Покупка подтверждена</b>\n\n` +
    `Тариф: <b>${plan}</b>\n` +
    `До: <b>${expiry}</b>\n\n` +
    `🔑 Ключ лицензии:\n` +
    `<code>${escapeHtml(license.licenseKey)}</code>`,

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

/* =========================================================
 * TELEGRAM UPDATE HANDLER
 * ======================================================= */

async function handleTelegramUpdate(
  config,
  store,
  keys,
  update
) {
  /* ---------------------------------
   * PRE CHECKOUT
   * -------------------------------- */

  if (
    update.pre_checkout_query
  ) {
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
      Boolean(
        parsed &&
        expected !== null &&

        String(
          parsed.telegramUserId
        ) ===
          String(
            query.from.id
          ) &&

        query.currency ===
          'XTR' &&

        Number(
          query.total_amount
        ) === expected &&

        (
          parsed.kind ===
            'standard' ||

          parsed.kind ===
            'pro' ||

          (
            parsed.kind ===
              'hello' &&

            config.helloWorld
              ?.enabled
          )
        )
      );

    await telegram(
      'answerPreCheckoutQuery',
      {
        pre_checkout_query_id:
          query.id,

        ok:
          valid,

        ...(valid
          ? {}
          : {
              error_message:
                'Заказ недействителен.',
            }),
      },
      config
    );

    return;
  }

  /* ---------------------------------
   * CALLBACK
   * -------------------------------- */

  if (
    update.callback_query
  ) {
    const callback =
      update.callback_query;

    const user =
      callback.from;

    rememberTelegramUser(
      store,
      user
    );

    const chatId =
      callback.message
        ?.chat?.id ||
      user.id;

    await answerCallback(
      config,
      callback.id
    );

    const data =
      String(
        callback.data || ''
      );

    if (
      data === 'home'
    ) {
      await sendText(
        config,
        chatId,

        '<b>✈️ X-TABLET</b>\n\n' +
        'Ваш companion cockpit для X-Plane 12.',

        mainKeyboard()
      );

      saveStore(store);

      return;
    }

    if (
      data === 'buy'
    ) {
      await sendText(
        config,
        chatId,

        '<b>🛒 X-TABLET</b>\n\nВыберите тариф:',

        planKeyboard()
      );

      return;
    }

    if (
      data === 'buy_hello'
    ) {
      if (
        config.helloWorld
          ?.enabled
      ) {
        await sendHelloWorldInvoice(
          config,
          user.id
        );
      }

      return;
    }

    if (
      data ===
        'buy_standard' ||
      data ===
        'buy_pro'
    ) {
      const plan =
        data ===
        'buy_pro'
          ? 'pro'
          : 'standard';

      const active =
        findUserLicense(
          store,
          user.id
        );

      if (
        active &&
        isActive(active)
      ) {
        await sendText(
          config,
          chatId,

          `🟢 У вас уже активна подписка <b>${currentPlan(active) === 'pro' ? 'Pro' : 'Standard'}</b> до <b>${new Date(active.expiresAt * 1000).toLocaleDateString('ru-RU')}</b>.`,

          mainKeyboard()
        );

        return;
      }

      const account =
        store.users[
          String(
            user.id
          )
        ] || {};

      if (
        !account.termsAcceptedAt
      ) {
        await sendText(
          config,
          chatId,

          '<b>Перед покупкой</b>\n\n' +
          'Прочитайте условия и политику конфиденциальности.',

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
        user.id,
        plan
      );

      return;
    }

    if (
      data.startsWith(
        'accept_terms_'
      )
    ) {
      const plan =
        data.endsWith('pro')
          ? 'pro'
          : 'standard';

      const id =
        String(
          user.id
        );

      store.users[id] =
        store.users[id] || {
          telegramUserId:
            id,
          createdAt:
            iso(),
        };

      store.users[id]
        .termsAcceptedAt =
        iso();

      store.users[id]
        .updatedAt =
        iso();

      audit(
        store,
        'terms_accepted',
        id,
        {
          plan,
        }
      );

      saveStore(store);

      await sendInvoice(
        config,
        user.id,
        plan
      );

      return;
    }

    if (
      data ===
      'terms_view'
    ) {
      await sendText(
        config,
        chatId,

        '<b>📄 Условия X-Tablet</b>\n\n' +
        'X-Tablet — цифровой companion для X-Plane 12. ' +
        'Цифровая подписка оплачивается Telegram Stars. ' +
        'После успешной оплаты создаётся лицензия.',

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
      data ===
      'privacy_view'
    ) {
      await sendText(
        config,
        chatId,

        '<b>🔒 Конфиденциальность</b>\n\n' +
        'Мы используем данные Telegram для оплаты, ' +
        'лицензирования, доступа к файлам и поддержки. ' +
        'Удаление данных можно запросить через поддержку.',

        {
          inline_keyboard: [
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
      data ===
      'subscription' ||
      data ===
      'account'
    ) {
      const license =
        findUserLicense(
          store,
          user.id
        );

      if (
        !license ||
        !isActive(license)
      ) {
        await sendText(
          config,
          chatId,

          '🔴 Активной подписки нет.',

          planKeyboard()
        );

        return;
      }

      await sendText(
        config,
        chatId,

        `👤 <b>Моя подписка</b>\n\n` +
        `Тариф: <b>${currentPlan(license) === 'pro' ? 'Pro' : 'Standard'}</b>\n` +
        `Статус: 🟢 активна\n` +
        `До: <b>${new Date(license.expiresAt * 1000).toLocaleString('ru-RU')}</b>\n\n` +
        `Лицензия:\n<code>${escapeHtml(license.licenseKey)}</code>`,

        mainKeyboard()
      );

      return;
    }

    if (
      data ===
      'device'
    ) {
      const license =
        findUserLicense(
          store,
          user.id
        );

      await sendText(
        config,
        chatId,

        license?.deviceId
          ? `📱 <b>Устройство подключено</b>\n\n<code>${escapeHtml(license.deviceId)}</code>`
          : '📱 Устройство ещё не подключено.\n\nЗапустите X-Tablet и используйте кнопку подключения через Telegram.',

        mainKeyboard()
      );

      return;
    }

    if (
      data ===
      'files'
    ) {
      const license =
        findUserLicense(
          store,
          user.id
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
        chatId,

        '⬇️ <b>Файлы X-Tablet</b>\n\n' +
        'Откройте защищённую страницу:',

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
      data ===
      'support'
    ) {
      await sendText(
        config,
        chatId,

        '<b>🆘 Поддержка</b>\n\n' +
        'Опишите проблему одним сообщением.\n\n' +
        'Платёжные вопросы: /paysupport',

        mainKeyboard()
      );

      return;
    }

    if (
      data ===
      'how_activate'
    ) {
      await sendText(
        config,
        chatId,

        '<b>📱 Активация X-Tablet</b>\n\n' +
        '1. Скачайте X-Tablet.\n' +
        '2. Запустите программу.\n' +
        '3. Нажмите «Подключить Telegram».\n' +
        '4. Подтвердите вход.\n' +
        '5. Лицензия подтянется автоматически.\n\n' +
        'Команды консоли не требуются.',

        mainKeyboard()
      );

      return;
    }

    return;
  }

  /* ---------------------------------
   * MESSAGE
   * -------------------------------- */

  const message =
    update.message;

  if (!message) {
    return;
  }

  if (
    message.from
  ) {
    rememberTelegramUser(
      store,
      message.from
    );
  }

  const userId =
    message.from?.id;

  if (!userId) {
    return;
  }

  const text =
    String(
      message.text || ''
    ).trim();

  /* ---------------------------------
   * SUCCESSFUL PAYMENT
   * -------------------------------- */

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
      ) !==
        String(userId)
    ) {
      return;
    }

    if (
      parsed.kind ===
      'hello'
    ) {
      if (
        config.helloWorld
          ?.enabled
      ) {
        await sendText(
          config,
          userId,

          '✅ <b>Hello World оплачен</b>\n\n' +
          'Тестовая цепочка Stars работает.',

          mainKeyboard()
        );
      }

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
      ) !== expected
    ) {
      console.error(
        '[payment] invalid amount'
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
        ? 'payment_duplicate'
        : 'payment_success',
      userId,
      {
        plan:
          parsed.kind,

        amount:
          payment.total_amount,

        chargeId:
          payment
            .telegram_payment_charge_id,
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

  /* ---------------------------------
   * /start DEVICE LINK
   * -------------------------------- */

  const parts =
    text.split(/\s+/);

  const command =
    (
      parts[0] || ''
    )
      .split('@')[0];

  const arg =
    parts[1] || '';

  if (
    command ===
      '/start' &&
    arg.startsWith(
      'link_'
    )
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

        '❌ Код подключения истёк. ' +
        'Создайте новый код в X-Tablet.',

        mainKeyboard()
      );

      return;
    }

    entry.telegramUserId =
      String(userId);

    entry.consumedAt =
      iso();

    audit(
      store,
      'telegram_device_link',
      userId,
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
        ? '✅ <b>Telegram подключён</b>\n\nВернитесь в X-Tablet — лицензия подтянется автоматически.'
        : '✅ <b>Telegram подключён</b>\n\nНа этом аккаунте сейчас нет активной подписки.',

      mainKeyboard()
    );

    return;
  }

  /* ---------------------------------
   * COMMANDS
   * -------------------------------- */

  if (
    command ===
      '/start' ||
    command ===
      '/menu'
  ) {
    await sendText(
      config,
      userId,

      '<b>✈️ X-TABLET</b>\n\n' +
      'Companion cockpit для X-Plane 12.',

      mainKeyboard()
    );

    return;
  }

  if (
    command ===
    '/buy'
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
    command ===
    '/license' ||
    command ===
    '/account'
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

    await sendText(
      config,
      userId,

      `👤 <b>Моя подписка</b>\n\n` +
      `Тариф: <b>${currentPlan(license) === 'pro' ? 'Pro' : 'Standard'}</b>\n` +
      `До: <b>${new Date(license.expiresAt * 1000).toLocaleDateString('ru-RU')}</b>\n\n` +
      `<code>${escapeHtml(license.licenseKey)}</code>`,

      mainKeyboard()
    );

    return;
  }

  if (
    command ===
    '/download'
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

    const url =
      issueSiteSession(
        store,
        config,
        license
      );

    await sendText(
      config,
      userId,

      '⬇️ <b>Файлы X-Tablet</b>\n\n' +
      'Откройте страницу скачивания:',

      {
        inline_keyboard: [
          [
            {
              text:
                '🌐 Открыть файлы',

              url,
            },
          ],
        ],
      }
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
      await sendText(
        config,
        userId,
        'У вас нет лицензии.',
        mainKeyboard()
      );

      return;
    }

    const lastReset =
      Number(
        license.resetAt || 0
      );

    if (
      now() -
      lastReset <
      RESET_COOLDOWN
    ) {
      const left =
        RESET_COOLDOWN -
        (
          now() -
          lastReset
        );

      const days =
        Math.ceil(
          left / DAY
        );

      await sendText(
        config,
        userId,

        `⏳ Перенос устройства будет доступен через ${days} дн.`,

        mainKeyboard()
      );

      return;
    }

    license.deviceId =
      null;

    license.deviceSecretHash =
      null;

    license.resetAt =
      now();

    license.updatedAt =
      iso();

    audit(
      store,
      'device_reset',
      userId
    );

    saveStore(store);

    await sendText(
      config,
      userId,

      '✅ Старое устройство отвязано. Теперь можно активировать X-Tablet на новом ПК.',

      mainKeyboard()
    );

    return;
  }

  if (
    command ===
    '/support'
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
        store.users[
          String(userId)
        ]?.username || '',

      message:
        text.replace(
          /^\/support\s*/i,
          ''
        ) ||
        'Пустое обращение',

      status:
        'open',

      createdAt:
        iso(),
    };

    saveStore(store);

    await sendText(
      config,
      userId,

      `✅ Обращение ${ticketId} создано.\n\nМы сохранили его в панели администратора.`,

      mainKeyboard()
    );

    return;
  }

  if (
    command ===
    '/paysupport'
  ) {
    await sendText(
      config,
      userId,

      '💳 <b>Платёжная поддержка</b>\n\n' +
      'Укажите номер платежа или опишите проблему. ' +
      'Для общего обращения используйте /support.',

      mainKeyboard()
    );

    return;
  }

  /* ---------------------------------
   * NORMAL TEXT
   * -------------------------------- */

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
        store.users[
          String(userId)
        ]?.username || '',

      message:
        text,

      status:
        'open',

      createdAt:
        iso(),
    };

    saveStore(store);

    await sendText(
      config,
      userId,

      `🆘 Сообщение передано в поддержку.\n\nTicket: <code>${ticketId}</code>`,

      mainKeyboard()
    );
  }
}

/* =========================================================
 * WEB
 * ======================================================= */

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
        config.publicSiteUrl
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

function json(
  res,
  status,
  value
) {
  res.writeHead(
    status,
    {
      'content-type':
        'application/json; charset=utf-8',

      'cache-control':
        'no-store',
    }
  );

  res.end(
    JSON.stringify(
      value
    )
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
    Buffer.concat(
      chunks
    ).toString(
      'utf8'
    );

  if (
    Buffer.byteLength(raw) >
    256 * 1024
  ) {
    throw new Error(
      'request_too_large'
    );
  }

  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

function adminFreeFileName() {
  return 'X-Tablet-Free.zip';
}

/* =========================================================
 * MAIN SERVER
 * ======================================================= */

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
          res.writeHead(
            204
          );

          return res.end();
        }

        try {
          const url =
            new URL(
              req.url,
              `http://${req.headers.host}`
            );

          /* ==========================================
           * TELEGRAM WEBHOOK
           * ======================================== */

          if (
            req.method ===
              'POST' &&
            url.pathname ===
              '/telegram/webhook'
          ) {
            const expectedSecret =
              crypto
                .createHash('sha256')
                .update(
                  `x-tablet-webhook:${config.botToken}`
                )
                .digest('hex');

            const suppliedSecret =
              String(
                req.headers[
                  'x-telegram-bot-api-secret-token'
                ] || ''
              );

            if (
              suppliedSecret !==
              expectedSecret
            ) {
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

            try {
              await handleTelegramUpdate(
                config,
                store,
                keys,
                update
              );
            } catch (error) {
              console.error(
                '[telegram]',
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

          /* ==========================================
           * ADMIN PAGE
           * ======================================== */

          if (
            req.method === 'GET' &&
            url.pathname ===
              '/admin.html'
          ) {
            const file =
              path.join(
                ROOT,
                'admin.html'
              );

            if (
              !fs.existsSync(file)
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

                'x-frame-options':
                  'DENY',

                'x-content-type-options':
                  'nosniff',
              }
            );

            return res.end(
              fs.readFileSync(
                file
              )
            );
          }

          /* ==========================================
           * ADMIN API
           * ======================================== */

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

            if (
              req.method ===
                'GET' &&
              url.pathname ===
                '/v1/admin/free-download'
            ) {
              const fileName =
                adminFreeFileName();

              const localPath =
                path.join(
                  DOWNLOAD_DIR,
                  fileName
                );

              if (
                fs.existsSync(
                  localPath
                )
              ) {
                return streamLocalFile(
                  res,
                  localPath,
                  fileName
                );
              }

              return proxyRemoteRelease(
                res,
                fileName
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
                !/^\d+$/.test(id)
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

          /* ==========================================
           * HEALTH
           * ======================================== */

          if (
            req.method === 'GET' &&
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

          /* ==========================================
           * PUBLIC CONFIG
           * ======================================== */

          if (
            req.method === 'GET' &&
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

                version:
                  1,
              }
            );
          }

          /* ==========================================
           * SITE SESSION
           * ======================================== */

          if (
            req.method === 'GET' &&
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

          /* ==========================================
           * DEVICE LINK START
           * ======================================== */

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

            const result =
              startDeviceLink(
                store,
                config,
                String(
                  body.deviceId || ''
                ).trim()
              );

            if (!result) {
              return json(
                res,
                400,
                {
                  error:
                    'device_id_invalid',
                }
              );
            }

            return json(
              res,
              200,
              result
            );
          }

          /* ==========================================
           * DEVICE LINK STATUS
           * ======================================== */

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

          /* ==========================================
           * DEVICE LINK CLAIM
           * ======================================== */

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

            const result =
              claimDeviceLink(
                store,
                keys,
                body
              );

            return json(
              res,
              result.status,
              result.body
            );
          }

          /* ==========================================
           * LICENSE ACTIVATE
           * ======================================== */

          if (
            req.method ===
              'POST' &&
            url.pathname ===
              '/v1/license/activate'
          ) {
            const ip =
              req.socket
                .remoteAddress ||
              'unknown';

            const stamp =
              now();

            const previous =
              activationAttempts.get(
                ip
              );

            if (
              !previous ||
              stamp -
                previous.startedAt >=
                ACTIVATION_WINDOW
            ) {
              activationAttempts.set(
                ip,
                {
                  startedAt:
                    stamp,

                  count:
                    1,
                }
              );
            } else {
              previous.count++;

              if (
                previous.count >
                ACTIVATION_LIMIT
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
              saveStore(store);
            }

            return json(
              res,
              result.status,
              result.body
            );
          }

          /* ==========================================
           * LICENSE HEARTBEAT
           * ======================================== */

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

          /* ==========================================
           * PAID DOWNLOAD
           * ======================================== */

          if (
            req.method === 'GET' &&
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
              Number(
                entry.expiresAt
              ) <= now()
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

            const localPath =
              path.join(
                DOWNLOAD_DIR,
                fileName
              );

            if (
              fs.existsSync(
                localPath
              )
            ) {
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

              saveStore(store);

              return streamLocalFile(
                res,
                localPath,
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

            saveStore(store);

            return proxyRemoteRelease(
              res,
              fileName
            );
          }

          /* ==========================================
           * ROOT
           * ======================================== */

          if (
            req.method === 'GET' &&
            url.pathname === '/'
          ) {
            res.writeHead(
              200,
              {
                'content-type':
                  'text/plain; charset=utf-8',

                'cache-control':
                  'no-store',
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
            '[server]',
            error
          );

          return json(
            res,
            500,
            {
              error:
                'server_error',

              message:
                error.message,
            }
          );
        }
      }
    );

  const listen =
    String(
      config.listen ||
      '0.0.0.0:8788'
    );

  const separator =
    listen.lastIndexOf(':');

  const host =
    listen.slice(
      0,
      separator
    );

  const port =
    Number(
      listen.slice(
        separator + 1
      )
    );

  server.listen(
    port,
    host,
    () => {
      console.log(
        `X-Tablet server listening on ${host}:${port}`
      );
    }
  );

  /* ==========================================
   * TELEGRAM WEBHOOK
   * ======================================== */

  const webhookSecret =
    crypto
      .createHash('sha256')
      .update(
        `x-tablet-webhook:${config.botToken}`
      )
      .digest('hex');

  const webhookUrl =
    `${config.publicApiUrl.replace(/\/$/, '')}` +
    '/telegram/webhook';

  try {
    await telegram(
      'setWebhook',
      {
        url:
          webhookUrl,

        secret_token:
          webhookSecret,

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
  } catch (error) {
    console.error(
      '[telegram] webhook setup failed:',
      error.message
    );
  }
}

/* =========================================================
 * START
 * ======================================================= */

main().catch(
  error => {
    console.error(
      '[fatal]',
      error
    );

    process.exit(1);
  }
);
