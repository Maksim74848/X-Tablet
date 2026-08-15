import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const port = String(process.env.PORT || "8788");

const config = {
  botToken: process.env.BOT_TOKEN || "",
  adminTelegramId: Number(process.env.ADMIN_TELEGRAM_ID || 0),

  publicSiteUrl: process.env.PUBLIC_SITE_URL || "",
  publicApiUrl: process.env.PUBLIC_API_URL || "",

  listen: `0.0.0.0:${port}`,

  helloWorld: {
    enabled: true
  },

  downloads: {
    windows:
      process.env.DOWNLOAD_WINDOWS ||
      "X-Tablet-Windows-Setup.exe",

    linux:
      process.env.DOWNLOAD_LINUX ||
      "X-Tablet-Linux-x64.tar.gz",

    macos:
      process.env.DOWNLOAD_MACOS ||
      "X-Tablet-macOS.dmg"
  },

  adminToken: process.env.ADMIN_TOKEN || "",

  termsUrl: process.env.TERMS_URL || "",
  privacyUrl: process.env.PRIVACY_URL || "",
  telegramBotUrl: process.env.TELEGRAM_BOT_URL || ""
};

const required = [
  ["BOT_TOKEN", config.botToken],
  ["PUBLIC_SITE_URL", config.publicSiteUrl],
  ["PUBLIC_API_URL", config.publicApiUrl],
  ["ADMIN_TOKEN", config.adminToken],
  ["TELEGRAM_BOT_URL", config.telegramBotUrl]
];

for (const [name, value] of required) {
  if (!value) {
    console.error(`Missing Render environment variable: ${name}`);
    process.exit(1);
  }
}

if (config.adminToken.length < 24) {
  console.error("ADMIN_TOKEN must be at least 24 characters long.");
  process.exit(1);
}

fs.writeFileSync(
  path.join(ROOT, "config.json"),
  JSON.stringify(config, null, 2),
  "utf8"
);

const child = spawn(
  process.execPath,
  [path.join(ROOT, "server.js")],
  {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit"
  }
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});

child.on("error", error => {
  console.error(error);
  process.exit(1);
});
