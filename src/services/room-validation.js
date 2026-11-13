const URL_SETTINGS = new Set([
  'customFaviconURL',
  'overwriteCashRegisterSound',
  'login_webhook_url',
  'logout_webhook_url',
  'customRoomURL',
  'custRoomDriveURL',
  'custLogoutURL',
  'openLoginLink',
  'loginErrorURL',
  'altBenzingaLogoURL',
  'altBenzingaLinkURL',
  'slackPostURL',
  'positionsIframeUrl',
  'tipMeBtnUrl',
  'customClientAlertPostURL',
  'runawayRecPostURL',
  'obsStreamSatusWebHookURL',
  'restreamToURL',
  'customPlayerURL',
  'customUserInfoURL',
  'chatServerURL',
  'customMobileAppIOSUrl',
  'customMobileAppAndroidUrl',
  'nqNewsFeedURL',
  'pairOKRedirect',
  'pairErrorRedirect',
  'logoURL',
  'bkgImg',
  'bkgImgHREF',
  'bkgImageURLHREF',
]);
function validRoomURL(value) {
  if (value == null || value === '') return true;
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const raw = value.trim();
  if (!raw) return true;
  try {
    const base = 'https://ptr.invalid',
      parsed = new URL(raw, base);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(raw);
    return isAbsolute || parsed.origin === base;
  } catch {
    return false;
  }
}
function timeMinutes(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(value)) return NaN;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}
function validateRoomField(field, value, settings) {
  if (URL_SETTINGS.has(field) && !validRoomURL(value))
    return 'Enter an HTTP(S) URL or a same-origin relative path.';
  if (field === 'tokenExpiresIn' && value != null && value !== '') {
    const match = typeof value === 'string' && value.trim().match(/^([1-9]\d*)(m|h|d)$/);
    const seconds = match && Number(match[1]) * { m: 60, h: 3600, d: 86400 }[match[2]];
    if (!match || !Number.isFinite(seconds) || seconds < 300 || seconds > 30 * 86400)
      return 'Enter a duration from 5m to 30d, such as 12h.';
  }
  if (field === 'autoOpenTime' || field === 'autoCloseTime') {
    const next = timeMinutes(value);
    if (Number.isNaN(next)) return 'Enter a valid 24-hour time such as 09:30.';
    const other = timeMinutes(
      settings[field === 'autoOpenTime' ? 'autoCloseTime' : 'autoOpenTime'],
    );
    if (next !== null && other !== null && !Number.isNaN(other) && next === other)
      return 'Open and close times must differ.';
  }
  return null;
}

module.exports = { validRoomURL, validateRoomField };
