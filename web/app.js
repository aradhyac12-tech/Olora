(function () {
  'use strict';
  var cfg = window.APP_CONFIG || {};
  var KEY = 'wcim.session';
  var root = document.getElementById('app');
  var state = { draft: {}, mode: 'login', error: '', busy: false, intro: null, list: null, loading: false, search: null, compose: null,
    tab: 'search', conns: null, connFilter: 'all', invs: null, profile: null, blocks: null, load: {}, invite: null, preview: null, fresh: null, targetLink: null };

  function load(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  function apiBase() { return (cfg.apiBase || '').replace(/\/+$/, ''); } // fixed at build time; no user-editable server address
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var MSG = { INVALID_CREDENTIALS: 'Wrong email or password.', EMAIL_TAKEN: 'That email is already registered.', RATE_LIMITED: 'Too many attempts. Wait a minute.',
    OAUTH_DISABLED: 'Google sign-in is not enabled on the server.', UNAUTHENTICATED: 'Session expired. Please sign in again.', INVALID_INPUT: 'Check the fields and try again.', NOT_FOUND: 'Not found.', FORBIDDEN: 'Not allowed.',
    INVALID_STATE: 'That action is not available right now.', DUPLICATE_OPEN: 'An open request for this already exists.', EXPIRED: 'This request has expired.',
    NOT_ELIGIBLE: 'No eligible introduction path.', IDEMPOTENCY_CONFLICT: 'Conflicting retry. Try again.', TOO_MANY_OPEN: 'Too many open requests.', INTERNAL: 'Server error.',
    INVITATION_UNAVAILABLE: 'This link is no longer available.', ALREADY_CONNECTED: 'You already have a connection or pending request with this person.',
    PROFILE_PRIVATE: 'Turn on "Let people find me" in Privacy first.', QUOTA_EXCEEDED: 'You reached a limit. Try again later.' };

  // fetch with a hard timeout so a sleeping/cold Render server can never leave the spinner on forever.
  function fetchT(url, opts, ms) {
    var ctl = window.AbortController ? new AbortController() : null, t = null;
    if (ctl) { opts = Object.assign({}, opts, { signal: ctl.signal }); t = setTimeout(function () { ctl.abort(); }, ms || 40000); }
    return fetch(url, opts).then(function (r) { clearTimeout(t); return r; },
      function (e) { clearTimeout(t); throw e; });
  }
  function call(method, path, body, extra) {
    var base = apiBase();
    if (!base) return Promise.reject({ code: 'NO_API' });
    var s = load(KEY), h = {};
    if (body !== undefined && body !== null) h['Content-Type'] = 'application/json';
    if (s && s.token && !(extra && extra.anon)) h.Authorization = 'Bearer ' + s.token;
    if (extra && extra.idem) h['Idempotency-Key'] = extra.idem;
    return fetchT(base + path, { method: method, headers: h, body: body !== undefined && body !== null ? JSON.stringify(body) : undefined }, 40000)
      .catch(function (e) { throw { code: e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK' }; })
      .then(function (r) {
        if (r.status === 204) return {};
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) {
            if (r.status === 401 && !(extra && extra.anon)) { localStorage.removeItem(KEY); }
            throw { code: (j && j.error && j.error.code) || 'HTTP_' + r.status, status: r.status, detail: j && j.error && j.error.detail };
          }
          return j;
        });
      });
  }
  function explain(e) {
    var m;
    if (e && e.code === 'NO_API') m = 'This build has no server configured.';
    else if (e && e.code === 'OAUTH_STATE') m = 'Google sign-in did not complete. Please try again.';
    else if (e && e.code === 'OAUTH_EXCHANGE') m = 'Google sign-in did not complete. Please try again.';
    else if (e && e.code === 'NETWORK') m = 'Cannot reach the server.';
    else if (e && e.code === 'TIMEOUT') m = 'Server did not answer in time (it may be asleep). Try again.';
    else m = MSG[e && e.code] || 'Something went wrong.';
    return m;
  }
  function run(fn) {
    state.busy = true; state.error = ''; render();
    var slow = setTimeout(function () { if (state.busy) toast('Server is waking up, please wait…', true); }, 8000);
    return fn().catch(function (e) { state.error = explain(e); }).then(function () { clearTimeout(slow); state.busy = false; render(); });
  }


  // ---- Google sign-in through Supabase (PKCE, no SDK) ----
  var PKCE = 'wcim.pkce';
  function b64url(buf) { var s = ''; new Uint8Array(buf).forEach(function (b) { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function randomVerifier() { var a = new Uint8Array(48); crypto.getRandomValues(a); return b64url(a); }
  function cap() { return window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() ? window.Capacitor.Plugins : null; }
  function redirectUri() { return cap() ? (cfg.appScheme || 'olora') + '://auth/callback' : location.origin + location.pathname; }
  function oauthEnabled() { return !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.crypto && crypto.subtle); }
  function startGoogle() {
    var verifier = randomVerifier(), stateVal = randomVerifier().slice(0, 24);
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(function (d) {
      localStorage.setItem(PKCE, JSON.stringify({ v: verifier, s: stateVal, t: Date.now() }));
      var u = cfg.supabaseUrl.replace(/\/+$/, '') + '/auth/v1/authorize?provider=google&flow_type=pkce&code_challenge=' + b64url(d) +
        '&code_challenge_method=s256&redirect_to=' + encodeURIComponent(redirectUri() + (cap() ? '' : '?wcim_state=' + stateVal));
      var c = cap();
      
      if (c && c.Browser) return c.Browser.open({ url: u });
      location.href = u;
    });
  }
  function finishGoogle(code, stateVal) {
    var saved = null; try { saved = JSON.parse(localStorage.getItem(PKCE) || 'null'); } catch (e) { /* none */ }
    localStorage.removeItem(PKCE);
    if (!saved || Date.now() - saved.t > 10 * 60 * 1000 || (stateVal && saved.s !== stateVal)) { return Promise.reject({ code: 'OAUTH_STATE' }); }
    
    return fetchT(cfg.supabaseUrl.replace(/\/+$/, '') + '/auth/v1/token?grant_type=pkce', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseAnonKey },
      body: JSON.stringify({ auth_code: code, code_verifier: saved.v }) }, 20000)
      .catch(function () { throw { code: 'NETWORK' }; })
      .then(function (r) { if (!r.ok) { throw { code: 'OAUTH_EXCHANGE', status: r.status }; } return r.json(); })
      .then(function (j) { var go = function () { return call('POST', '/v1/auth/oauth/supabase', { accessToken: j.access_token }, { anon: true }); }; return go().catch(function (e) { if (e && e.code === 'NETWORK') return go(); throw e; }); })
      .then(function (j) { save(KEY, { token: j.token, userId: j.userId, expiresAt: j.expiresAt }); });
  }
  // Deep links: olora://introduction/<id> (also ?intro=<id> on the web) opens that introduction once signed in.
  var TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
  var INV_KEY = 'wcim.invite';
  function ss(fn) { try { return fn(window.sessionStorage); } catch (e) { return null; } }
  // Invitation links carry an opaque secret. It lives in the URL fragment (never sent to a server), is moved into session storage,
  // and is stripped from the address bar / history immediately.
  function setInvite(kind, token) { state.invite = { kind: kind, token: token }; state.preview = null; state.targetLink = null; ss(function (st) { st.setItem(INV_KEY, JSON.stringify(state.invite)); }); }
  function clearInvite() { state.invite = null; state.preview = null; state.targetLink = null; ss(function (st) { st.removeItem(INV_KEY); }); }
  function readHash() {
    var m = /^#\/([it])\/([A-Za-z0-9_-]{43})$/.exec(location.hash || '');
    if (m) { setInvite(m[1], m[2]); try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ } return true; }
    return false;
  }
  function restoreInvite() { var v = ss(function (st) { return JSON.parse(st.getItem(INV_KEY) || 'null'); }); if (v && TOKEN_RE.test(v.token || '') && (v.kind === 'i' || v.kind === 't')) state.invite = v; }
  var UUID = /^[0-9a-fA-F-]{8,64}$/;
  function introFromUrl(u) {
    var id = u.hostname === 'introduction' ? u.pathname.replace(/^\/+/, '') : (u.searchParams.get('intro') || '');
    return UUID.test(id) ? id : '';
  }
  function handleDeepLink(href) {
    var u; try { u = new URL(href); } catch (e) { return false; }
    if (u.protocol !== (cfg.appScheme || 'olora') + ':' && !/^https?:$/.test(u.protocol)) return false;
    var tk = u.hostname === 'invite' || u.hostname === 'target' ? u.pathname.replace(/^\/+/, '') : '';
    if (TOKEN_RE.test(tk)) { setInvite(u.hostname === 'invite' ? 'i' : 't', tk); render(); return true; }
    var id = introFromUrl(u);
    if (!id) return false;
    save('wcim.pending', id);
    state.intro = null; render();
    return true;
  }
  var lastCode = '';
  function handleCallbackUrl(href) {
    var u; try { u = new URL(href); } catch (e) { return false; }
    var code = u.searchParams.get('code'), st = u.searchParams.get('wcim_state');
    if (!code) return false;
    
    if (code === lastCode) return true;
    lastCode = code;
    run(function () { return finishGoogle(code, st); });
    return true;
  }

  var STATUS = { pending_connector: ['Waiting for connector', ''], pending_target: ['Waiting for target', ''], accepted: ['Accepted', 'ok'], declined: ['Declined', 'bad'], cancelled: ['Cancelled', 'mute'], expired: ['Expired', 'mute'] };
  var GLOGO = '<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
  var toastT = null;
  function toast(msg, ok) {
    var old = document.getElementById('toast'); if (old) old.remove();
    var t = document.createElement('div'); t.id = 'toast'; t.className = 'toast' + (ok ? ' ok' : ''); t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t); clearTimeout(toastT); toastT = setTimeout(function () { t.remove(); }, 4200);
  }
  function spin(on, label) { return on ? '<span class="spin" aria-hidden="true"></span>' : label; }

  function flush() { if (state.error) { toast(state.error); state.error = ''; } }

  function authView() {
    var reg = state.mode === 'register';
    root.innerHTML = '<div class="auth"><img class="logo-lg" src="logo.svg" alt="olora"><h1>olora</h1><p class="tag">Warm introductions, through people who know you.</p>' +
      (state.invite ? '<p class="notice" role="status">You opened an Olora link. Sign in or create an account to see it.</p>' : '') +
      (oauthEnabled() ? '<button type="button" class="google" id="google"' + (state.busy ? ' disabled' : '') + '>' + GLOGO + 'Continue with Google</button><div class="or"><span>or use email</span></div>' : '') +
      '<form class="card" id="authForm">' +
      (reg ? '<label for="dn">Your name</label><input id="dn" maxlength="100" autocomplete="name" required>' : '') +
      '<label for="em">Email</label><input id="em" type="email" maxlength="254" autocomplete="email" inputmode="email" required>' +
      '<label for="pw">Password</label><input id="pw" type="password" maxlength="128" ' + (reg ? 'minlength="10" ' : '') + 'autocomplete="' + (reg ? 'new-password' : 'current-password') + '" required>' +
      (reg ? '<p class="meta">At least 10 characters.</p>' : '') +
      '<button type="submit"' + (state.busy ? ' disabled' : '') + '>' + spin(state.busy, reg ? 'Create account' : 'Sign in') + '</button></form>' +
      '<button type="button" class="link" id="swap">' + (reg ? 'I already have an account' : 'New here? Create an account') + '</button>' + '</div>';
    flush();
    var g = document.getElementById('google');
    if (g) g.onclick = function () { startGoogle().catch(function () { toast('Could not start Google sign-in.'); }); };
    document.getElementById('swap').onclick = function () { state.mode = reg ? 'login' : 'register'; render(); };
    document.getElementById('authForm').onsubmit = function (ev) {
      ev.preventDefault();
      var email = document.getElementById('em').value.trim(), pw = document.getElementById('pw').value;
      var dn = reg ? document.getElementById('dn').value.trim() : '';
      run(function () {
        var p = reg ? call('POST', '/v1/auth/register', { email: email, password: pw, displayName: dn }, { anon: true }) : Promise.resolve();
        return p.then(function () { return call('POST', '/v1/auth/login', { email: email, password: pw }, { anon: true }); })
          .then(function (j) { save(KEY, { token: j.token, userId: j.userId, expiresAt: j.expiresAt }); });
      });
    };
  }

  // ================================================================ helpers
  function when(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  var TYPES = { acquaintance: 'Acquaintance', colleague: 'Colleague', classmate: 'Classmate', family: 'Family', community_member: 'Community member' };
  function typeOpts() { return Object.keys(TYPES).map(function (k) { return '<option value="' + k + '">' + esc(TYPES[k]) + '</option>'; }).join(''); }
  function avatar(p) {
    var u = p && p.avatarUrl;
    if (typeof u === 'string' && /^https:\/\//i.test(u)) return '<img class="av" src="' + esc(u) + '" alt="" referrerpolicy="no-referrer" loading="lazy">';
    return '<span class="av ph" aria-hidden="true">' + esc(String((p && p.displayName) || '?').trim().charAt(0).toUpperCase() || '?') + '</span>';
  }
  function shareUrl(kind, token) { var base = cfg.publicUrl || (cap() ? '' : location.origin + location.pathname); return base ? base + '#/' + kind + '/' + token : ''; }
  function extractToken(text) { var m = String(text || '').match(/([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/); return m ? m[1] : ''; }
  function copy(text, okMsg) {
    var ok = function () { toast(okMsg || 'Copied', true); }, bad = function () { toast('Copy failed. Select the text and copy it manually.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, bad);
    else { var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); ok(); } catch (e) { bad(); } ta.remove(); }
  }
  function status(code) { return code === 'permission' ? 'You do not have access to this.' : explain({ code: code }); }

  // One loader per resource: loading / error (with retry) / loaded. Data stays visible while it reloads.
  var RES = { conns: ['/v1/connections', function (j) { state.conns = j.connections || []; }], invs: ['/v1/invitations/sent', function (j) { state.invs = j.invitations || []; }],
    profile: ['/v1/profile', function (j) { state.profile = j.profile; }], blocks: ['/v1/blocks', function (j) { state.blocks = j.blocks || []; }],
    intros: ['/v1/introductions?limit=50', function (j) { state.list = j.introductions || []; }] };
  function need(key) {
    if (state.load[key]) return;
    state.load[key] = 'loading';
    call('GET', RES[key][0]).then(function (j) { RES[key][1](j); state.load[key] = 'ok'; }, function (e) { state.load[key] = 'err:' + (e && e.status === 403 ? 'permission' : (e && e.code) || 'NETWORK'); })
      .then(function () { render(); });
  }
  function stale() { for (var i = 0; i < arguments.length; i++) state.load[arguments[i]] = undefined; }
  function panel(key, title, body, emptyMsg, isEmpty) {
    var st = state.load[key] || 'loading';
    if (st.indexOf('err:') === 0) return '<div class="card"><h2>' + esc(title) + '</h2><p class="empty" role="alert">' + esc(status(st.slice(4))) + '</p><button type="button" class="sec" data-do="retry" data-k="' + key + '">Try again</button></div>';
    if (st === 'loading' && !(state[{ conns: 'conns', invs: 'invs', profile: 'profile', blocks: 'blocks', intros: 'list' }[key]])) return '<div class="card"><h2>' + esc(title) + '</h2><p class="meta"><span class="spin dark" aria-hidden="true"></span> Loading…</p></div>';
    if (isEmpty) return '<div class="card"><h2>' + esc(title) + '</h2><p class="empty">' + esc(emptyMsg) + '</p></div>';
    return body;
  }

  // ================================================================ introductions (unchanged semantics)
  function introCard(i, me) {
    var st = STATUS[i.status] || [i.status || 'Unknown', 'mute'];
    var roles = []; if (i.requesterId === me) roles.push('requester'); if (i.connectorId === me) roles.push('connector'); if (i.targetId === me) roles.push('target');
    var acts = [];
    if (roles.indexOf('connector') >= 0 && i.status === 'pending_connector') acts.push(['connector_accept', 'Accept', ''], ['connector_decline', 'Decline', 'danger']);
    if (roles.indexOf('target') >= 0 && i.status === 'pending_target') acts.push(['target_accept', 'Accept', ''], ['target_decline', 'Decline', 'danger']);
    if (roles.indexOf('requester') >= 0 && (i.status === 'pending_connector' || i.status === 'pending_target')) acts.push(['requester_cancel', 'Cancel request', 'sec full']);
    var role = roles.length ? 'You are the ' + roles.join(' and ') : '';
    return '<div class="card"><div class="row"><h2>Introduction</h2><span class="pill ' + st[1] + '">' + esc(st[0]) + '</span></div>' +
      chain(i) + (i.message ? '<div class="msg">' + esc(i.message) + '</div>' : '') +
      '<p class="meta">' + esc(role) + (i.expiresAt ? (role ? ' · ' : '') + 'expires ' + esc(when(i.expiresAt)) : '') + '</p>' +
      (acts.length ? '<div class="actions">' + acts.map(function (a) { return '<button class="' + a[2] + '" data-do="intro" data-act="' + a[0] + '" data-id="' + esc(i.id) + '"' + (state.busy ? ' disabled' : '') + '>' + a[1] + '</button>'; }).join('') + '</div>' : '') + '</div>';
  }
  function chain(i) { return i.requesterName ? '<p class="meta chain">' + esc(i.requesterName) + ' → ' + esc(i.connectorName) + ' → ' + esc(i.targetName) + '</p>' : ''; }

  // ================================================================ search by shared link
  function routeRow(r) {
    var hops = r.hops === 2 ? 'has a confirmed connection with them' : r.hops + ' steps away';
    return '<div class="route"><div><strong>' + esc(r.connector.displayName || 'Someone you know') + '</strong><p class="meta">' + esc(hops) + '</p></div>' +
      (r.canRequest ? '<button type="button" class="sec" data-do="ask" data-c="' + esc(r.connector.id) + '" data-name="' + esc(r.connector.displayName) + '">Ask</button>' : '<span class="pill mute">Not yet</span>') + '</div>';
  }
  function searchBlock() {
    var s = state.search, out = '';
    if (s && s.error) out = '<p class="empty" role="alert">' + esc(s.error) + '</p>';
    else if (s && s.result) {
      var res = s.result;
      out = '<div class="who">' + avatar(res.target) + '<div><strong>' + esc(res.target.displayName) + '</strong><p class="meta">Name from their own profile. Olora does not verify identities.</p></div></div>' +
        (res.status === 'found'
          ? '<div class="routes">' + res.routes.map(routeRow).join('') + '</div>' + (res.complete ? '' : '<p class="meta">Search stopped early. There may be more routes.</p>') +
            '<p class="meta">Routes use only relationships both people confirmed on Olora. People outside that contributed network cannot be found.</p>'
          : '<p class="empty">No introduction route right now. It may appear once someone you know confirms a connection toward them.</p>');
    }
    return '<form class="card" id="searchForm"><h2>Find a route to someone</h2><p class="sub">Open the link they shared with you, or paste it here. You never need to type an ID.</p>' +
      '<label for="lk">Their Olora link</label><input id="lk" maxlength="400" placeholder="Paste a link" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(s ? s.raw || '' : '') + '" required>' +
      '<button type="submit"' + (state.busy ? ' disabled' : '') + '>' + spin(state.busy, 'Search') + '</button>' + out + '</form>';
  }
  function composeBlock() {
    var c = state.compose; if (!c) return '';
    return '<form class="card" id="composeForm"><h2>Ask ' + esc(c.name || 'your contact') + '</h2><p class="sub">They see your message and decide whether to pass it on to ' + esc(c.target || 'them') + '.</p>' +
      '<label for="ms">Your message</label><textarea id="ms" rows="3" maxlength="1000" placeholder="Say why you would like to meet" required></textarea>' +
      '<div class="actions"><button type="submit"' + (state.busy ? ' disabled' : '') + '>' + spin(state.busy, 'Send request') + '</button><button type="button" class="sec" data-do="cancelCompose">Cancel</button></div></form>';
  }
  function searchTab(me) {
    need('intros');
    var list = panel('intros', 'Your introductions', '<h2 class="sect">Your introductions</h2>' + (state.list || []).map(function (i) { return introCard(i, me); }).join(''),
      'Nothing yet. Open someone’s link to find a route and ask for your first introduction.', state.list && !state.list.length);
    var opened = state.intro && !(state.list || []).some(function (x) { return x.id === state.intro.id; });
    return (opened ? introCard(state.intro, me) : '') + composeBlock() + searchBlock() + list;
  }

  // ================================================================ connections
  function connCard(c) {
    var pill = c.status === 'confirmed' ? ['Connected', 'ok'] : c.status === 'pending' ? [c.awaiting === 'you' ? 'Needs your answer' : 'Waiting for them', ''] : ['Ended', 'mute'];
    var acts = '';
    if (c.status === 'pending' && c.awaiting === 'you') acts = '<div class="actions"><button data-do="confirm" data-id="' + esc(c.id) + '">Confirm</button><button class="danger" data-do="declineConn" data-id="' + esc(c.id) + '">Decline</button></div>';
    else if (c.status === 'pending') acts = '<button class="sec" data-do="withdraw" data-id="' + esc(c.id) + '">Withdraw request</button>';
    else if (c.status === 'confirmed') {
      acts = '<label class="switch"><input type="checkbox" data-do="perm" data-id="' + esc(c.id) + '"' + (c.yourPermission === 'granted' ? ' checked' : '') + '> <span>Allow introductions through this connection</span></label>' +
        '<p class="meta">' + (c.introductionsActive ? 'Active for introduction routes.' : 'Not used for introduction routes right now.') + '</p>' +
        '<div class="actions"><button class="sec" data-do="revoke" data-id="' + esc(c.id) + '" data-name="' + esc(c.other.displayName) + '">Remove</button><button class="danger" data-do="blockConn" data-id="' + esc(c.id) + '" data-name="' + esc(c.other.displayName) + '">Block</button></div>';
    }
    if (c.status !== 'ended') acts += '<button type="button" class="link" data-do="reportConn" data-id="' + esc(c.id) + '" data-name="' + esc(c.other.displayName) + '">Report</button>';
    return '<div class="card"><div class="row"><div class="who">' + avatar(c.other) + '<div><h2>' + esc(c.other.displayName) + '</h2><p class="meta">' + esc(TYPES[c.relationshipType] || c.relationshipType) + '</p></div></div><span class="pill ' + pill[1] + '">' + pill[0] + '</span></div>' +
      (c.note ? '<div class="msg">' + esc(c.note) + '</div>' : '') +
      '<p class="meta">' + (c.status === 'confirmed' ? 'Confirmed by both of you ' + esc(when(c.confirmedAt)) : c.status === 'pending' ? 'Expires ' + esc(when(c.confirmBy)) : c.endedByMe ? 'You ended this' : 'This connection ended') + '</p>' + acts + '</div>';
  }
  function connectionsTab() {
    need('conns');
    var f = state.connFilter, all = state.conns || [];
    var shown = all.filter(function (c) { return f === 'all' || c.status === f; });
    var chips = ['all', 'pending', 'confirmed', 'ended'].map(function (k) { return '<button type="button" class="chip' + (f === k ? ' on' : '') + '" data-do="filter" data-k="' + k + '">' + k.charAt(0).toUpperCase() + k.slice(1) + '</button>'; }).join('');
    return '<div class="chips" role="group" aria-label="Filter connections">' + chips + '</div>' +
      panel('conns', 'Connections', shown.map(connCard).join(''), f === 'all' ? 'No connections yet. Create an invitation, or open one you received.' : 'Nothing here.', state.conns && !shown.length) +
      '<p class="meta">A connection counts for introductions only after both people confirm it, and only while neither withdraws permission.</p>';
  }

  // ================================================================ invitations
  function invCard(v) {
    var pill = { active: ['Active', 'ok'], used: ['Used', 'mute'], expired: ['Expired', 'mute'], revoked: ['Revoked', 'bad'] }[v.status] || [v.status, 'mute'];
    return '<div class="card"><div class="row"><h2>' + (v.purpose === 'introduce' ? 'Find-me link' : esc(TYPES[v.relationshipType] || 'Connection') + ' invitation') + '</h2><span class="pill ' + pill[1] + '">' + esc(pill[0]) + '</span></div>' +
      (v.note ? '<div class="msg">' + esc(v.note) + '</div>' : '') +
      '<p class="meta">' + (v.purpose === 'connect' ? esc(v.useCount + ' of ' + v.maxUses + ' used · ') : '') + 'expires ' + esc(when(v.expiresAt)) + '</p>' +
      (v.status === 'active' ? '<button class="danger" data-do="revokeInv" data-id="' + esc(v.id) + '">Revoke link</button>' : '') + '</div>';
  }
  function freshBlock() {
    var f = state.fresh; if (!f) return '';
    var url = shareUrl(f.purpose === 'introduce' ? 't' : 'i', f.token) || f.token;
    return '<div class="card hl"><h2>Your link is ready</h2><p class="sub">This is the only time the full link is shown. Copy it now.</p><code class="tok">' + esc(url) + '</code>' +
      '<div class="actions"><button data-do="copyFresh">Copy</button>' + (navigator.share ? '<button class="sec" data-do="shareFresh">Share</button>' : '') + '</div>' +
      (f.purpose === 'connect' ? '<p class="meta">Anyone who opens it can ask to connect; you still confirm each person yourself.</p>' : '<p class="meta">Anyone signed in can see your name and look for a route to you. Revoke it any time.</p>') + '<button class="link" data-do="dismissFresh">Done</button></div>';
  }
  function invitesTab() {
    need('invs');
    var list = panel('invs', 'Links you created', '<h2 class="sect">Links you created</h2>' + (state.invs || []).map(invCard).join(''), 'No links yet.', state.invs && !state.invs.length);
    return freshBlock() +
      '<form class="card" id="inviteForm"><h2>Invite someone to connect</h2><p class="sub">Creates a private link. They accept, then you confirm — nobody is connected until both of you agree.</p>' +
      '<label for="rt">How do you know them?</label><select id="rt">' + typeOpts() + '</select>' +
      '<label for="nt">Note (optional)</label><input id="nt" maxlength="200" placeholder="e.g. We met at the meetup">' +
      '<div class="two"><div><label for="mu">People who can use it</label><select id="mu"><option value="1">1 person</option><option value="5">Up to 5</option><option value="25">Up to 25</option></select></div>' +
      '<div><label for="ex">Expires after</label><select id="ex"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></div></div>' +
      '<button type="submit"' + (state.busy ? ' disabled' : '') + '>' + spin(state.busy, 'Create link') + '</button></form>' +
      '<form class="card" id="pasteForm"><h2>Got a link?</h2><p class="sub">Paste an invitation or find-me link you received.</p><label for="pl">Link</label><input id="pl" maxlength="400" autocomplete="off" autocapitalize="off" spellcheck="false" required><button type="submit" class="sec">Open</button></form>' +
      '<div class="card"><h2>Let people find a route to you</h2><p class="sub">A find-me link lets someone check whether people they know can introduce them to you. It needs “Let people find me” turned on in Profile.</p><button class="sec" data-do="mkTarget"' + (state.busy ? ' disabled' : '') + '>Create find-me link</button></div>' + list;
  }

  // ================================================================ profile & privacy
  function profileTab() {
    need('profile'); need('blocks');
    var p = state.profile;
    var body = '';
    if (p) {
      body = '<form class="card" id="profForm"><h2>Your profile</h2><div class="who">' + avatar(p) + '<p class="meta">' + esc(p.email) + '</p></div>' +
        '<label for="pn">Display name</label><input id="pn" maxlength="100" value="' + esc(p.displayName) + '" required>' +
        '<label for="pa">Picture (https link, optional)</label><input id="pa" maxlength="500" inputmode="url" autocapitalize="off" value="' + esc(p.avatarUrl || '') + '" placeholder="https://…">' +
        '<button type="submit"' + (state.busy ? ' disabled' : '') + '>' + spin(state.busy, 'Save profile') + '</button></form>' +
        '<div class="card"><h2>Privacy</h2><p class="sub">Everything starts private. These are two separate choices.</p>' +
        '<label class="switch"><input type="checkbox" data-do="priv" data-k="discoverable"' + (p.discoverable ? ' checked' : '') + '> <span><strong>Let people find me</strong><br><span class="meta">Anyone with your find-me link can search for a route to you. Off by default.</span></span></label>' +
        '<label class="switch"><input type="checkbox" data-do="priv" data-k="acceptsIntroductions"' + (p.acceptsIntroductions ? ' checked' : '') + '> <span><strong>Let people ask me for introductions</strong><br><span class="meta">Your confirmed connections can route introduction requests through you. Off by default. You can still turn off individual connections.</span></span></label></div>' +
        '<div class="card"><h2>Other accounts</h2><p class="sub">Handles you add are self-declared and shown only to you. Olora does not verify them or connect to those services.</p>' +
        (p.identities.length ? p.identities.map(function (x) { return '<div class="route"><div><strong>' + esc(x.platform) + '</strong> ' + esc(x.username) + '<p class="meta">Self-declared · not verified</p></div><button class="ghost" data-do="rmId" data-id="' + esc(x.id) + '">Remove</button></div>'; }).join('') : '<p class="empty">None added.</p>') +
        '<form id="idForm"><label for="ip">Platform</label><select id="ip"><option>instagram</option><option>linkedin</option><option>x</option><option>github</option><option>website</option><option>other</option></select><label for="iu">Handle</label><input id="iu" maxlength="100" autocapitalize="off" required><button type="submit" class="sec">Add</button></form></div>';
    }
    var b = state.blocks;
    var blocks = panel('blocks', 'Blocked people', '<div class="card"><h2>Blocked people</h2>' + (b || []).map(function (x) { return '<div class="route"><div class="who">' + avatar(x) + '<strong>' + esc(x.displayName) + '</strong></div><button class="sec" data-do="unblock" data-id="' + esc(x.id) + '">Unblock</button></div>'; }).join('') +
      '<p class="meta">They are never told. Blocking ends any connection and removes you from each other’s routes. Unblocking does not restore it.</p></div>', 'You have not blocked anyone.', b && !b.length);
    return panel('profile', 'Profile', body, '', false) + blocks +
      '<div class="card"><h2>Your data</h2><button class="sec" data-do="export">Download my data</button>' +
      '<form id="delForm"><label for="dp">Delete account</label><p class="meta">Permanently removes your profile, connections, links and blocks.</p><input id="dp" type="password" maxlength="128" placeholder="Password (if you set one)" autocomplete="current-password"><input id="dc" maxlength="40" placeholder="Type: delete my account" autocomplete="off" required><button type="submit" class="danger">Delete my account</button></form></div>';
  }

  // ================================================================ invitation landing
  function landing() {
    var iv = state.invite, p = state.preview;
    if (!p) {
      state.preview = { loading: true };
      call('POST', '/v1/invitations/preview', { token: iv.token }).then(function (j) { state.preview = { data: j.invitation }; }, function (e) { state.preview = { error: e && e.code === 'INVITATION_UNAVAILABLE' ? '' : explain(e), gone: !e || e.code === 'INVITATION_UNAVAILABLE' }; }).then(render);
      return '<div class="card"><p class="meta"><span class="spin dark" aria-hidden="true"></span> Opening link…</p></div>';
    }
    if (p.loading) return '<div class="card"><p class="meta"><span class="spin dark" aria-hidden="true"></span> Opening link…</p></div>';
    var back = '<button class="link" data-do="leaveInvite">Back to Olora</button>';
    if (p.done) return '<div class="card"><h2>' + esc(p.done.title) + '</h2><p class="sub">' + esc(p.done.text) + '</p><button data-do="leaveInvite">Continue</button></div>';
    if (p.gone || p.error) return '<div class="card"><h2>Link unavailable</h2><p class="sub">' + esc(p.error || 'This link has expired, was revoked, was already used, or is not meant for you.') + '</p>' + back + '</div>';
    var d = p.data;
    if (d.purpose === 'introduce') {
      return '<div class="card"><div class="who">' + avatar(d.from) + '<div><h2>' + esc(d.from.displayName) + '</h2><p class="meta">Name from their own profile · not verified</p></div></div><p class="sub">shared a find-me link. Check if someone you know can introduce you.</p>' +
        '<button data-do="searchLink">Look for a route</button>' + back + '</div>';
    }
    var disabled = d.existing !== 'none';
    return '<div class="card"><div class="who">' + avatar(d.from) + '<div><h2>' + esc(d.from.displayName) + '</h2><p class="meta">Name from their own profile · not verified</p></div></div>' +
      '<p class="sub">invited you to connect as <strong>' + esc((TYPES[d.relationshipType] || 'a connection').toLowerCase()) + '</strong>.</p>' + (d.note ? '<div class="msg">' + esc(d.note) + '</div>' : '') +
      (disabled ? '<p class="empty">You already have a ' + esc(d.existing === 'confirmed' ? 'confirmed connection' : 'pending request') + ' with this person.</p>' :
        '<p class="meta">Accepting sends them a request. You are connected only after they confirm too.</p><div class="actions"><button data-do="acceptInv"' + (state.busy ? ' disabled' : '') + '>Accept</button><button class="sec" data-do="declineInv">Decline</button></div>') +
      '<div class="actions"><button type="button" class="link" data-do="blockInv">Block</button><button type="button" class="link" data-do="reportInv">Report</button></div>' + back + '</div>';
  }

  // ================================================================ shell + events
  var TABS = [['search', 'Find'], ['connections', 'Connections'], ['invites', 'Invitations'], ['profile', 'Profile']];
  function mainView() {
    var s = load(KEY), me = s.userId, body;
    if (state.invite) body = landing();
    else body = state.tab === 'connections' ? connectionsTab() : state.tab === 'invites' ? invitesTab() : state.tab === 'profile' ? profileTab() : searchTab(me);
    var nav = '<nav class="tabs" aria-label="Sections">' + TABS.map(function (t) { return '<button type="button" class="tab' + (!state.invite && state.tab === t[0] ? ' on' : '') + '" data-do="tab" data-k="' + t[0] + '"' + (!state.invite && state.tab === t[0] ? ' aria-current="page"' : '') + '>' + t[1] + '</button>'; }).join('') + '</nav>';
    root.innerHTML = '<div class="topbar"><div class="brand"><img src="logo.svg" alt="">olora</div><button class="ghost" data-do="out" type="button">Sign out</button></div>' + nav + body;
    flush();
    var pend = load('wcim.pending');
    if (pend && !state.busy) { localStorage.removeItem('wcim.pending'); run(function () { return call('GET', '/v1/introductions/' + encodeURIComponent(pend)).then(function (j) { state.intro = j.introduction; state.tab = 'search'; }); }); }
  }
  function val(id) { var e = document.getElementById(id); return e ? e.value : ''; }
  function refreshAll() { stale('conns', 'invs', 'profile', 'blocks', 'intros'); }
  function act(fn, doneMsg, keys) { return run(function () { return fn().then(function () { if (doneMsg) toast(doneMsg, true); if (keys) stale.apply(null, keys); }); }); }
  function reportDialog(subject, name) {
    var r = window.prompt('Report ' + name + '. Reason: spam, harassment, impersonation, unsafe, or other', 'spam');
    if (r === null) return;
    r = r.trim().toLowerCase(); if (['spam', 'harassment', 'impersonation', 'unsafe', 'other'].indexOf(r) < 0) { toast('Choose one of: spam, harassment, impersonation, unsafe, other.'); return; }
    var also = window.confirm('Also block ' + name + '? They will not be told.');
    act(function () { return call('POST', '/v1/reports', { subject: subject, reason: r, alsoBlock: also }, { idem: uuid() }); }, 'Report sent. Thank you.', ['conns', 'blocks']);
  }
  var DO = {
    tab: function (el) { state.tab = el.getAttribute('data-k'); state.draft = {}; clearInvite(); stale.apply(null, { search: ['intros'], connections: ['conns'], invites: ['invs'], profile: ['profile', 'blocks'] }[state.tab]); render(); },
    retry: function (el) { stale(el.getAttribute('data-k')); render(); },
    out: function () { run(function () { return call('POST', '/v1/auth/logout').catch(function () {}).then(function () { localStorage.removeItem(KEY); clearInvite(); state.intro = null; state.list = null; state.search = null; state.compose = null; state.conns = state.invs = state.profile = state.blocks = null; state.load = {}; state.fresh = null; }); }); },
    filter: function (el) { state.connFilter = el.getAttribute('data-k'); render(); },
    ask: function (el) { state.compose = { connectorId: el.getAttribute('data-c'), name: el.getAttribute('data-name'), token: state.search.token, target: state.search.result.target.displayName }; render(); var m = document.getElementById('ms'); if (m) m.focus(); },
    cancelCompose: function () { state.compose = null; render(); },
    intro: function (el) { var id = el.getAttribute('data-id'); act(function () { return call('POST', '/v1/introductions/' + encodeURIComponent(id) + '/transitions', { action: el.getAttribute('data-act') }, { idem: uuid() }).then(function (j) { if (state.intro && state.intro.id === id) state.intro = j.introduction; }); }, 'Done', ['intros']); },
    confirm: function (el) { act(function () { return call('POST', '/v1/connections/' + encodeURIComponent(el.getAttribute('data-id')) + '/confirm'); }, 'Connected', ['conns']); },
    declineConn: function (el) { if (window.confirm('Decline this request?')) act(function () { return call('POST', '/v1/connections/' + encodeURIComponent(el.getAttribute('data-id')) + '/decline'); }, 'Declined', ['conns']); },
    withdraw: function (el) { act(function () { return call('POST', '/v1/connections/' + encodeURIComponent(el.getAttribute('data-id')) + '/revoke'); }, 'Withdrawn', ['conns']); },
    revoke: function (el) { if (window.confirm('Remove your connection with ' + el.getAttribute('data-name') + '? It cannot be restored; you would both need to connect again.')) act(function () { return call('POST', '/v1/connections/' + encodeURIComponent(el.getAttribute('data-id')) + '/revoke'); }, 'Connection removed', ['conns']); },
    perm: function (el) { var on = el.checked; act(function () { return call('PUT', '/v1/connections/' + encodeURIComponent(el.getAttribute('data-id')) + '/permission', { allowIntroductions: on }); }, on ? 'Introductions allowed' : 'Introductions paused', ['conns']); },
    blockConn: function (el) { if (window.confirm('Block ' + el.getAttribute('data-name') + '? This ends the connection and they are not told.')) act(function () { return call('POST', '/v1/blocks', { subject: { connectionId: el.getAttribute('data-id') } }); }, 'Blocked', ['conns', 'blocks']); },
    reportConn: function (el) { reportDialog({ connectionId: el.getAttribute('data-id') }, el.getAttribute('data-name')); },
    unblock: function (el) { act(function () { return call('DELETE', '/v1/blocks/' + encodeURIComponent(el.getAttribute('data-id'))); }, 'Unblocked', ['blocks']); },
    revokeInv: function (el) { if (window.confirm('Revoke this link? Nobody will be able to use it.')) act(function () { return call('POST', '/v1/invitations/' + encodeURIComponent(el.getAttribute('data-id')) + '/revoke'); }, 'Link revoked', ['invs']); },
    mkTarget: function () { act(function () { return call('POST', '/v1/invitations', { purpose: 'introduce' }, { idem: uuid() }).then(function (j) { state.fresh = { token: j.token, purpose: 'introduce' }; }); }, '', ['invs']); },
    copyFresh: function () { copy(shareUrl(state.fresh.purpose === 'introduce' ? 't' : 'i', state.fresh.token) || state.fresh.token, 'Link copied'); },
    shareFresh: function () { var u = shareUrl(state.fresh.purpose === 'introduce' ? 't' : 'i', state.fresh.token) || state.fresh.token; navigator.share({ title: 'Olora', url: /^https?:/.test(u) ? u : undefined, text: /^https?:/.test(u) ? undefined : u }).catch(function () {}); },
    dismissFresh: function () { state.fresh = null; render(); },
    leaveInvite: function () { clearInvite(); render(); },
    acceptInv: function () { act(function () { return call('POST', '/v1/invitations/accept', { token: state.invite.token }).then(function (j) { state.preview = { done: { title: 'Request sent', text: ((state.preview.data && state.preview.data.from.displayName) || 'They') + ' must confirm before you are connected. You will see it under Connections.' } }; }); }, '', ['conns']); },
    declineInv: function () { act(function () { return call('POST', '/v1/invitations/decline', { token: state.invite.token }).then(function () { state.preview = { done: { title: 'Declined', text: 'They are not notified.' } }; }); }); },
    blockInv: function () { if (window.confirm('Block this person? They are not told.')) act(function () { return call('POST', '/v1/blocks', { subject: { invitationToken: state.invite.token } }).then(function () { state.preview = { done: { title: 'Blocked', text: 'You will not see each other in routes or links.' } }; }); }, '', ['blocks']); },
    reportInv: function () { reportDialog({ invitationToken: state.invite.token }, 'this sender'); },
    searchLink: function () { var tk = state.invite.token; clearInvite(); state.tab = 'search'; doLinkSearch(tk, ''); },
    priv: function (el) { var body = {}; body[el.getAttribute('data-k')] = el.checked; act(function () { return call('PUT', '/v1/privacy', body).then(function (j) { state.profile = j.profile; }); }, 'Saved', ['invs']); },
    rmId: function (el) { act(function () { return call('DELETE', '/v1/identities/' + encodeURIComponent(el.getAttribute('data-id'))).then(function (j) { state.profile = j.profile; }); }, 'Removed'); },
    export: function () {
      run(function () { var sess = load(KEY); return fetchT(apiBase() + '/v1/account/export', { headers: { Authorization: 'Bearer ' + sess.token } }, 40000).then(function (r) { if (!r.ok) throw { code: 'HTTP_' + r.status }; return r.blob(); })
        .then(function (b) { var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'olora-export.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000); }); });
    },
  };
  function doLinkSearch(token, raw) {
    state.search = { token: token, raw: raw, result: null }; state.compose = null;
    run(function () {
      return call('POST', '/v1/search/by-link', { token: token }).then(function (j) { state.search.result = j; }, function (e) {
        state.search.error = e && e.code === 'INVITATION_UNAVAILABLE' ? 'This link is not available. It may have expired, been turned off, or is not meant for you.' : explain(e);
      });
    });
  }
  var FORMS = {
    searchForm: function () { var raw = val('lk'), tk = extractToken(raw); if (!tk) { toast('That does not look like an Olora link.'); return; } doLinkSearch(tk, raw); },
    composeForm: function () {
      var c = state.compose; run(function () { return call('POST', '/v1/introductions', { connectorId: c.connectorId, targetToken: c.token, message: val('ms') }, { idem: uuid() }).then(function () { state.compose = null; state.search = null; toast('Request sent', true); stale('intros'); }); });
    },
    inviteForm: function () {
      var body = { purpose: 'connect', relationshipType: val('rt'), maxUses: Number(val('mu')), expiresInDays: Number(val('ex')) }, n = val('nt').trim(); if (n) body.note = n;
      act(function () { return call('POST', '/v1/invitations', body, { idem: uuid() }).then(function (j) { state.fresh = { token: j.token, purpose: 'connect' }; }); }, '', ['invs']);
    },
    pasteForm: function () { var tk = extractToken(val('pl')); if (!tk) { toast('That does not look like an Olora link.'); return; } setInvite('i', tk); render(); },
    profForm: function () { var a = val('pa').trim(); act(function () { return call('PATCH', '/v1/profile', { displayName: val('pn'), avatarUrl: a === '' ? null : a }).then(function (j) { state.profile = j.profile; }); }, 'Saved'); },
    idForm: function () { act(function () { return call('POST', '/v1/identities', { platform: val('ip'), username: val('iu') }).then(function (j) { state.profile = j.profile; }); }, 'Added'); },
    delForm: function () {
      if (!window.confirm('Permanently delete your account and all your data?')) return;
      var body = { confirm: val('dc').trim() }; if (val('dp')) body.password = val('dp');
      run(function () { return call('POST', '/v1/account/delete', body).then(function () { localStorage.removeItem(KEY); clearInvite(); state.profile = state.conns = state.invs = state.blocks = state.list = null; state.load = {}; toast('Account deleted', true); }); });
    },
  };
  // Delegated events: one listener for the whole app, so re-rendering never loses handlers.
  root.addEventListener('click', function (ev) {
    var el = ev.target.closest ? ev.target.closest('[data-do]') : null; if (!el || el.tagName === 'INPUT') return;
    if (DO[el.getAttribute('data-do')]) DO[el.getAttribute('data-do')](el);
  });
  root.addEventListener('change', function (ev) { var el = ev.target; if (el && el.tagName === 'INPUT' && el.getAttribute('data-do') && DO[el.getAttribute('data-do')]) DO[el.getAttribute('data-do')](el); });
  root.addEventListener('submit', function (ev) {
    var f = ev.target; if (f && f.id && FORMS[f.id]) { ev.preventDefault(); FORMS[f.id](); }
  });

  // Async loads re-render the page; keep whatever the user has typed (by element id) so a refresh never wipes a form.
  function render() {
    var s = load(KEY); if (s && s.token) mainView(); else authView();
    Object.keys(state.draft).forEach(function (id) { var e = document.getElementById(id); if (e && e.type !== 'checkbox' && e.value !== state.draft[id]) e.value = state.draft[id]; });
  }
  root.addEventListener('input', function (ev) { var e = ev.target; if (e && e.id && e.type !== 'checkbox') state.draft[e.id] = e.value; });
  root.addEventListener('change', function (ev) { var e = ev.target; if (e && e.id && e.tagName === 'SELECT') state.draft[e.id] = e.value; });
  root.addEventListener('submit', function (ev) { var f = ev.target; if (f && f.elements) Array.prototype.forEach.call(f.elements, function (e) { if (e.id) delete state.draft[e.id]; }); }, true);

  // Return from Google: browser redirect carries ?code=...; the Android app gets it via the custom-scheme deep link.
  var c0 = cap();
  if (c0 && c0.App) c0.App.addListener('appUrlOpen', function (ev) { if (ev && ev.url && (handleCallbackUrl(ev.url) || handleDeepLink(ev.url))) { if (c0.Browser && c0.Browser.close) c0.Browser.close().catch(function () {}); } });
  // App was killed while the Custom Tab was open: the callback arrives as the launch URL instead of appUrlOpen.
  if (c0 && c0.App && c0.App.getLaunchUrl) c0.App.getLaunchUrl().then(function (r) { if (r && r.url && localStorage.getItem(PKCE)) handleCallbackUrl(r.url); }).catch(function () {});
  // Wake a sleeping free-tier server while the user is still on the login screen.
  try { if (apiBase()) fetchT(apiBase() + '/healthz', { method: 'GET' }, 60000).catch(function () {}); } catch (e) { /* ignore */ }
  if (!cap() && location.search.indexOf('intro=') !== -1) handleDeepLink(location.href);
  if (!cap() && location.search.indexOf('code=') !== -1) { var had = handleCallbackUrl(location.href); if (had) history.replaceState(null, '', location.pathname); }
  restoreInvite(); readHash();
  window.addEventListener('hashchange', function () { if (readHash()) render(); });
  if (!state.busy) render();
})();
