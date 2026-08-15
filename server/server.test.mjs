import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DEFAULT_PLANS, MONTH, generateLicenseKey, hashSecret, issueActivationToken, verifyToken, upsertLicenseAfterPayment, activationRateLimited, activateLicense, siteSession, expectedStars, hasActiveSubscription, rememberTelegramUser, adminSummary, adminData, privacyDelete, createDeviceLink, findDeviceLink, userProfile } from './server.js';

const t = () => Math.floor(Date.now() / 1000);
assert.equal(MONTH, 2592000);
assert.deepEqual(DEFAULT_PLANS.standard.companionSlots, 1);
assert.deepEqual(DEFAULT_PLANS.pro.companionSlots, 4);
assert.equal(expectedStars('standard'), 199);
assert.equal(expectedStars('pro'), 399);
assert.equal(expectedStars('hello'), 1);

const key = generateLicenseKey();
assert.match(key, /^XT-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
assert.equal(hashSecret('abc'), crypto.createHash('sha256').update('abc').digest('hex'));

const pair = crypto.generateKeyPairSync('ed25519');
const baseLicense = { id: 'LIC-1', licenseKey: key, plan: 'standard', expiresAt: t()+MONTH, deviceId:'XT-DEVICE', status:'active', deviceSecretHash:hashSecret('correct-secret-12345678901234567890123456') };
const token = issueActivationToken(baseLicense, 'XT-DEVICE', { privateKey: pair.privateKey });
const verified = verifyToken(token, { publicKey: pair.publicKey });
assert.equal(verified.deviceId, 'XT-DEVICE');
assert.equal(verified.plan, 'standard');

const store = { licenses:{}, payments:{}, purchaseSessions:{}, downloadTokens:{}, supportTickets:{} };
const first = upsertLicenseAfterPayment(store, '123', 'pro', {telegram_payment_charge_id:'charge-1', total_amount:399, currency:'XTR', subscription_expiration_date:t()+MONTH});
assert.equal(first.duplicate, false);
assert.equal(first.license.plan, 'pro');
assert.equal(first.license.licenseKey, store.licenses[first.license.id].licenseKey);
const duplicate = upsertLicenseAfterPayment(store, '123', 'pro', {telegram_payment_charge_id:'charge-1', total_amount:399, currency:'XTR', subscription_expiration_date:t()+MONTH});
assert.equal(duplicate.duplicate, true);
assert.equal(hasActiveSubscription(store, '123').plan, 'pro');

const stored = { licenses:{L:{id:'L',licenseKey:'XT-AAAAA-BBBBB-CCCCC-DDDDD',plan:'standard',status:'active',expiresAt:t()+MONTH,deviceId:null,deviceSecretHash:null}}, payments:{}, purchaseSessions:{}, downloadTokens:{}, supportTickets:{} };
const firstActivation = activateLicense(stored, {privateKey:pair.privateKey}, {licenseKey:'XT-AAAAA-BBBBB-CCCCC-DDDDD',deviceId:'DEVICE-ONE-12345',deviceSecret:'correct-secret-12345678901234567890123456'});
assert.equal(firstActivation.status, 200);
assert.equal(stored.licenses.L.deviceId,'DEVICE-ONE-12345');
const sameDeviceWrongSecret = activateLicense(stored, {privateKey:pair.privateKey}, {licenseKey:'XT-AAAAA-BBBBB-CCCCC-DDDDD',deviceId:'DEVICE-ONE-12345',deviceSecret:'wrong-secret-12345678901234567890123456'});
assert.equal(sameDeviceWrongSecret.status,401);
const secondDevice = activateLicense(stored, {privateKey:pair.privateKey}, {licenseKey:'XT-AAAAA-BBBBB-CCCCC-DDDDD',deviceId:'DEVICE-TWO-99999',deviceSecret:'second-secret-12345678901234567890123456'});
assert.equal(secondDevice.status,409);

const config = {publicApiUrl:'https://license.example.com', downloads:{windows:'XTablet-Windows.zip',linux:'XTablet-Linux.zip',macos:'XTablet-macOS.zip'}};
stored.purchaseSessions.S={token:'S',licenseId:'L',telegramUserId:'777',expiresAt:t()+600};
const session = siteSession(stored, config, 'S');
assert.equal(session.plan,'standard');
assert.match(session.files.windows,/download/);

const ip='test-ip';
for(let i=0;i<8;i++) assert.equal(activationRateLimited(ip), false);
assert.equal(activationRateLimited(ip), true);


// Full buyer journey: successful payment -> license -> site session -> files -> activation.
const journeyStore = { licenses:{}, payments:{}, purchaseSessions:{}, downloadTokens:{}, supportTickets:{} };
const payment = { telegram_payment_charge_id:'journey-charge-1', total_amount:199, currency:'XTR', subscription_expiration_date:t()+MONTH };
const paid = upsertLicenseAfterPayment(journeyStore, '9001', 'standard', payment);
assert.equal(paid.duplicate, false);
assert.equal(paid.license.plan, 'standard');
assert.equal(paid.license.telegramUserId, '9001');
const site = siteSession(journeyStore, {publicApiUrl:'https://license.example.com', downloads:{windows:'X-Tablet-Windows-x64.exe',linux:'X-Tablet-Linux-x64',macos:'X-Tablet-macOS-universal.zip'}}, Object.assign(journeyStore.purchaseSessions, {
  SESSION:{token:'SESSION', licenseId:paid.license.id, telegramUserId:'9001', expiresAt:t()+600}
}) && 'SESSION');
assert.equal(site.plan, 'standard');
assert.match(site.licenseKey, /^XT-/);
assert.deepEqual(Object.keys(site.files).sort(), ['linux','macos','windows']);
const activated = activateLicense(journeyStore, {privateKey:pair.privateKey}, {licenseKey:paid.license.licenseKey, deviceId:'DEVICE-JOURNEY-123', deviceSecret:'journey-device-secret-12345678901234567890'});
assert.equal(activated.status, 200);
assert.equal(activated.body.public.plan, 'standard');
const renewed = upsertLicenseAfterPayment(journeyStore, '9001', 'standard', {telegram_payment_charge_id:'journey-charge-2', total_amount:199, currency:'XTR', subscription_expiration_date:t()+2*MONTH});
assert.equal(renewed.duplicate, false);
assert.equal(renewed.license.id, paid.license.id);
assert.ok(renewed.license.expiresAt > payment.subscription_expiration_date);

console.log('server tests: PASS');


const adminStore = {users:{}, licenses:{}, payments:{}, purchaseSessions:{}, downloadTokens:{}, supportTickets:{}, auditLog:[]};
rememberTelegramUser(adminStore, {id:777, username:'pilot777', first_name:'Максим', last_name:'Pilot', language_code:'ru'});
const paidAdmin = upsertLicenseAfterPayment(adminStore, '777', 'standard', {telegram_payment_charge_id:'admin-charge', total_amount:199, currency:'XTR', subscription_expiration_date:t()+MONTH});
assert.equal(adminSummary(adminStore).users, 1);
assert.equal(adminSummary(adminStore).activeLicenses, 1);
assert.equal(adminData(adminStore).users[0].username, 'pilot777');
privacyDelete(adminStore, '777');
assert.equal(adminSummary(adminStore).users, 0);
assert.equal(Object.keys(adminStore.licenses).length, 0);

console.log('admin/privacy tests: PASS');

const linkStore = {users:{}, licenses:{}, payments:{}, purchaseSessions:{}, downloadTokens:{}, supportTickets:{}, deviceLinks:{}, auditLog:[]};
rememberTelegramUser(linkStore, {id:4242, username:'pilot42', first_name:'Test', last_name:'Pilot'});
const linkCode = createDeviceLink(linkStore, 'XT-AAAAAAAAAAAAAAAAAAAA');
assert.ok(findDeviceLink(linkStore, linkCode));
const linkEntry = findDeviceLink(linkStore, linkCode);
linkEntry.telegramUserId = '4242';
assert.equal(userProfile(linkStore, '4242').telegramUserId, '4242');
assert.equal(userProfile(linkStore, '4242').username, 'pilot42');
console.log('telegram account link tests: PASS');
