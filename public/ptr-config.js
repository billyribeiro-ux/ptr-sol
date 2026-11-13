/* Optional deployment-specific endpoints; defaults do not contact the source service. */
window.PTR_CONFIG = window.PTR_CONFIG || {};
function ptrEscape(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c];
  });
}

// Legacy Janus expects adapter globals that current browsers no longer expose.
(function (w, nav) {
  w.RTCPeerConnection = w.RTCPeerConnection || w.webkitRTCPeerConnection || w.mozRTCPeerConnection;
  w.RTCSessionDescription = w.RTCSessionDescription || w.webkitRTCSessionDescription || w.mozRTCSessionDescription;
  w.RTCIceCandidate = w.RTCIceCandidate || w.webkitRTCIceCandidate || w.mozRTCIceCandidate;
  if (!w.getUserMedia) {
    var legacy = nav.getUserMedia || nav.webkitGetUserMedia || nav.mozGetUserMedia;
    if (nav.mediaDevices && nav.mediaDevices.getUserMedia) {
      w.getUserMedia = function (constraints, success, failure) {
        nav.mediaDevices.getUserMedia(constraints).then(success, failure);
      };
    } else if (legacy) {
      w.getUserMedia = legacy.bind(nav);
    }
  }
  if (!w.attachMediaStream) w.attachMediaStream = function (element, stream) {
    if (element) element.srcObject = stream;
    return element;
  };
  if (!w.reattachMediaStream) w.reattachMediaStream = function (to, from) {
    if (to && from) to.srcObject = from.srcObject;
    return to;
  };
  var details = w.adapter && w.adapter.browserDetails || {};
  var ua = nav.userAgent || '';
  w.webrtcDetectedBrowser = w.webrtcDetectedBrowser || details.browser || (/Firefox\//.test(ua) ? 'firefox' : /Edg\//.test(ua) ? 'edge' : /Chrome\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'unknown');
  w.webrtcDetectedVersion = w.webrtcDetectedVersion || details.version || Number((ua.match(/(?:Firefox|Chrome|Version)\/(\d+)/) || [])[1] || 0);
})(window, navigator);

// Keep operational diagnostics while removing credential-bearing fields and JWTs.
function ptrRedactLog(value, depth, seen) {
  depth = depth || 0;
  if (typeof value === 'string') {
    return value
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
      .replace(/(["']?(?:pw|password|pass|pass2|token|tokenSite|jwtToken|jwtTokenSite|roomToken|apiSecret|apiKey|api_key|siteToken|turnPW|rapidAPIKey|secret|password_hash|authorization|pin|pairCode|fcmTokens|__al)["']?\s*[:=]\s*)(["'])(.*?)\2/gi, '$1"[redacted]"')
      .replace(/(\b(?:pw|password|pass|pass2|token|tokenSite|jwtToken|jwtTokenSite|roomToken|apiSecret|apiKey|api_key|siteToken|turnPW|rapidAPIKey|secret|password_hash|authorization|pin|pairCode|__al)\s*[:=]\s*)([^\s,;}]+)/gi, '$1[redacted]')
      .replace(/(bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[redacted]');
  }
  if (!value || typeof value !== 'object') return value;
  if (depth >= 4) return '[object]';
  seen = seen || new WeakSet();
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (value instanceof Error) return ptrRedactLog(value.message, depth + 1, seen);
  if (Array.isArray(value)) return value.map(function (item) { return ptrRedactLog(item, depth + 1, seen); });
  var result = {};
  Object.keys(value).forEach(function (key) {
    result[key] = /^(?:pw|password|pass|pass2|token|tokenSite|jwtToken|jwtTokenSite|roomToken|apiSecret|apiKey|api_key|siteToken|turnPW|rapidAPIKey|secret|password_hash|authorization|pin|pairCode|fcmTokens|__al)$/i.test(key)
      ? '[redacted]' : ptrRedactLog(value[key], depth + 1, seen);
  });
  return result;
}
(function () {
  if (!window.console) return;
  ['log', 'info', 'debug', 'warn', 'error'].forEach(function (name) {
    var original = window.console[name];
    if (typeof original !== 'function') return;
    window.console[name] = function () {
      original.apply(window.console, Array.prototype.map.call(arguments, function (value) { return ptrRedactLog(value); }));
    };
  });
})();

// Build link markup through DOM APIs; never interpolate a URL into HTML or JS.
function ptrSafeHttpURL(value) {
  try {
    var url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch (error) { return null; }
}
function ptrLinkHTML(value) {
  var url = ptrSafeHttpURL(value), el = document.createElement(url ? 'a' : 'span');
  el.textContent = String(value == null ? '' : value);
  if (url) { el.href = url; el.target = '_blank'; el.rel = 'noopener noreferrer'; el.className = 'ptr-chat-link'; }
  return el.outerHTML;
}
function ptrImageHTML(value, lineBreak) {
  var url = ptrSafeHttpURL(value);
  if (!url) return ptrLinkHTML(value);
  var el = document.createElement('div'), img = document.createElement('img');
  el.className = 'img-container ptr-chat-image';
  el.setAttribute('data-image-url', url);
  img.className = 'uploaded-img'; img.src = url; el.appendChild(img);
  if (lineBreak) { var br = document.createElement('br'); br.setAttribute('clear', 'both'); el.appendChild(br); }
  return el.outerHTML;
}
if (typeof document !== 'undefined') document.addEventListener('click', function (event) {
  var target = event.target && event.target.closest && event.target.closest('.ptr-chat-image, .ptr-chat-link');
  if (!target) return;
  event.stopPropagation();
  if (target.classList.contains('ptr-chat-image')) {
    var url = ptrSafeHttpURL(target.getAttribute('data-image-url'));
    if (url && typeof window.imageModal === 'function') window.imageModal(event, url);
  }
}, true);

// CSS values inserted into generated markup must be colors, not declarations.
function ptrSafeColor(value) {
  value = String(value == null ? '' : value).trim();
  return /^(?:#[0-9a-f]{3,8}|[a-z]{1,24}|(?:rgb|rgba|hsl|hsla)\([0-9.,% +\/-]+\))$/i.test(value) ? value : 'inherit';
}
function ptrLinkifyText(value, wrapper) {
  var text = String(value == null ? '' : value), pattern = /\bhttps?:\/\/[^\s]+/gi, result = '', pos = 0, match;
  while ((match = pattern.exec(text))) {
    result += ptrEscape(text.slice(pos, match.index)) + wrapper(match[0]);
    pos = match.index + match[0].length;
  }
  return result + ptrEscape(text.slice(pos));
}
function ptrImagePreviewHTML(value, maximum, clickable) {
  var url = ptrSafeHttpURL(value);
  if (!url) return '';
  var box = document.createElement('div'), img = document.createElement('img');
  box.className = clickable ? 'posted-img ptr-chat-image' : 'posted-img';
  if (clickable) box.setAttribute('data-image-url', url);
  img.src = url; img.style.maxWidth = maximum + 'px';
  if (clickable) img.style.maxHeight = maximum + 'px';
  box.appendChild(img);
  return box.outerHTML;
}
if (typeof document !== 'undefined') document.addEventListener('click', function (event) {
  var button = event.target && event.target.closest && event.target.closest('[data-ptr-private-reply]');
  if (button && typeof window.doPrivReply === 'function') {
    event.stopPropagation();
    window.doPrivReply(button.getAttribute('data-ptr-private-reply'));
  }
}, true);
// The ingest URL is a per-session secret; keep it out of logs and persistent storage.
function ptrShowObsIngest(raw) {
  var u;
  try { u = new URL(String(raw)); } catch (_) { return false; }
  if ((u.protocol !== 'rtmp:' && u.protocol !== 'rtmps:') || u.username || u.password || u.search || u.hash) return false;
  var slash = u.pathname.lastIndexOf('/');
  if (slash < 1 || slash === u.pathname.length - 1) return false;
  var server = u.protocol + '//' + u.host + u.pathname.slice(0, slash), key = u.pathname.slice(slash + 1);
  var container = document.createElement('div'), title = document.createElement('h4');
  title.textContent = 'Enter these settings in OBS or XSplit'; container.appendChild(title);
  function addField(label, value) {
    var fieldLabel = document.createElement('label'), input = document.createElement('input'), copy = document.createElement('button');
    fieldLabel.textContent = label; input.type = 'text'; input.className = 'form-control'; input.readOnly = true; input.value = value;
    copy.type = 'button'; copy.className = 'btn btn-warning'; copy.textContent = 'Copy';
    copy.addEventListener('click', function () { input.select(); document.execCommand('copy'); });
    container.appendChild(fieldLabel); container.appendChild(input); container.appendChild(copy); container.appendChild(document.createElement('br'));
  }
  addField('RTMP URL', server); addField('Stream Key', key);
  bootbox.dialog({message: window.jQuery(container), closeButton: true, onEscape: true});
  return true;
}
// OBS can optionally relay to YouTube; credentials remain in memory only.
function ptrRequestObsStart(onStart) {
  var content = document.createElement('div'), intro = document.createElement('p');
  intro.textContent = 'Optionally stream to YouTube at the same time. Leave these fields blank for OBS only.';
  content.appendChild(intro);
  function addField(label, type) {
    var text = document.createElement('label'), input = document.createElement('input');
    text.textContent = label; input.type = type; input.className = 'form-control'; input.autocomplete = 'off';
    content.appendChild(text); content.appendChild(input); return input;
  }
  var key = addField('YouTube stream key', 'password');
  var url = addField('YouTube server URL (optional)', 'url');
  bootbox.confirm({message: window.jQuery(content), callback: function (confirmed) {
    if (!confirmed) return;
    var streamKey = key.value.trim(), server = url.value.trim(), options = {};
    if (server && !streamKey) { bootbox.alert('Enter a YouTube stream key or leave both fields empty.'); return false; }
    if (streamKey) options.ytKey = streamKey;
    if (server) options.ytURL = server;
    onStart(options);
  }});
}
// Name-only roster mode exposes no avatar, location, tagline, or badges.
function ptrCreateNameOnlyRosterItem(user, prefix) {
  var li = document.createElement('li'), body = document.createElement('div'), heading = document.createElement('div'), link = document.createElement('a');
  li.className = 'media bb mediaLI'; li.id = prefix + String(user.uid);
  body.className = 'media-body'; heading.className = 'media-heading'; link.href = ''; link.style.color = '#000';
  link.textContent = String(user.nick || ''); heading.appendChild(link); body.appendChild(heading); li.appendChild(body);
  return li;
}
