/**
 * XETE Wallet Connection Component (askAI-style)
 *
 * Drop into any page:
 *   <link rel="stylesheet" href="/solana-login.css">
 *   <div id="wallet-connect"></div>
 *   <script src="/js/wallet-auth.js"></script>
 *
 * Auto-inits on DOMContentLoaded if #wallet-connect is present.
 * Connected state shows abbreviated pubkey (XXXX…YYYY) or .sol domain.
 */

// Official Solana logo, replicated from solana.com (Dec 2025).
const SOL_LOGO_SVG = `
<svg width="16" height="14" viewBox="0 0 16 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="xeteSolGrad" x1="1.35" y1="14.33" x2="14.16" y2="-0.43" gradientUnits="userSpaceOnUse">
      <stop offset="0.08" stop-color="#9945FF"/>
      <stop offset="0.30" stop-color="#8752F3"/>
      <stop offset="0.50" stop-color="#5497D5"/>
      <stop offset="0.60" stop-color="#43B4CA"/>
      <stop offset="0.72" stop-color="#28E0B9"/>
      <stop offset="0.97" stop-color="#14F195"/>
    </linearGradient>
  </defs>
  <path d="M2.62 10.27a.62.62 0 0 1 .44-.18h12.31c.27 0 .41.33.22.52l-2.44 2.44a.62.62 0 0 1-.44.18H.4c-.28 0-.41-.33-.22-.52l2.44-2.44z" fill="url(#xeteSolGrad)"/>
  <path d="M2.62.74A.64.64 0 0 1 3.07.56h12.3c.28 0 .41.33.22.52L13.16 3.5a.62.62 0 0 1-.44.18H.4C.13 3.68 0 3.35.18 3.16L2.62.74z" fill="url(#xeteSolGrad)"/>
  <path d="M13.16 5.48a.62.62 0 0 0-.44-.18H.4c-.28 0-.41.33-.22.52L2.62 8.26a.62.62 0 0 0 .44.18h12.3c.28 0 .41-.33.22-.52l-2.42-2.44z" fill="url(#xeteSolGrad)"/>
</svg>
`;

const CARET_SVG = `
<svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

// Base58 (Bitcoin alphabet) — Phantom deeplink params (keys/nonce/payload/signature)
// are base58. tweetnacl doesn't ship a base58 codec, so we inline a small correct one
// (avoids another CDN dependency / CSP allowance).
const XETE_B58 = (function () {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const BASE = 58;
    const MAP = {};
    for (let i = 0; i < ALPHABET.length; i++) MAP[ALPHABET[i]] = i;
    function encode(bytes) {
        bytes = Array.from(bytes);
        if (bytes.length === 0) return '';
        const digits = [0];
        for (let i = 0; i < bytes.length; i++) {
            let carry = bytes[i];
            for (let j = 0; j < digits.length; j++) {
                carry += digits[j] << 8;
                digits[j] = carry % BASE;
                carry = (carry / BASE) | 0;
            }
            while (carry > 0) { digits.push(carry % BASE); carry = (carry / BASE) | 0; }
        }
        let str = '';
        for (let k = 0; k < bytes.length - 1 && bytes[k] === 0; k++) str += ALPHABET[0];
        for (let q = digits.length - 1; q >= 0; q--) str += ALPHABET[digits[q]];
        return str;
    }
    function decode(str) {
        if (!str || str.length === 0) return new Uint8Array(0);
        const bytes = [0];
        for (let i = 0; i < str.length; i++) {
            const value = MAP[str[i]];
            if (value === undefined) throw new Error('Invalid base58 char: ' + str[i]);
            let carry = value;
            for (let j = 0; j < bytes.length; j++) {
                carry += bytes[j] * BASE;
                bytes[j] = carry & 0xff;
                carry >>= 8;
            }
            while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
        }
        for (let k = 0; k < str.length - 1 && str[k] === ALPHABET[0]; k++) bytes.push(0);
        return new Uint8Array(bytes.reverse());
    }
    return { encode, decode };
})();

const XETE_AUTH = {
    API_BASE: '',
    _step: 0,

    async init(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        this._container = container;

        // Debug: enable a persistent on-page trail with ?dldebug=1 (survives redirects).
        try { if (/[?&]dldebug=1/.test(location.href)) localStorage.setItem('xete_dl_debug_on', '1'); } catch (e) {}
        this._dlLog('init xdl=' + (new URLSearchParams(location.search).get('xdl') || 'none')
            + ' search=' + (location.search ? location.search.slice(0, 80) : '(none)'));

        // If we're returning from a Phantom deeplink round-trip, finish it FIRST
        // (buttery: a clean overlay + auto-resume of the pending intent, no flash of
        // the connect button before we redirect/auth).
        // resume-once guard: wallet-auth auto-inits on DOMContentLoaded AND pages may
        // call init() explicitly -> double-init. Setting _resumeStarted synchronously
        // (before the first await) makes the second init skip the resume.
        if (this._dlIsReturn() && !this._resumeStarted) {
            this._resumeStarted = true;
            try {
                await this._dlResume();
            } catch (e) {
                console.error('[wallet] deeplink resume failed', e);
                this._dlOverlayHide();
                this._dlReset();
                this.showToast('Sign-in could not be completed: ' + ((e && e.message) || e), 'err');
            }
            // fall through to normal render (session may now be authenticated)
        }

        const session = await this.getSession();
        if (session.authenticated) {
            this.renderConnected(container, session);
        } else {
            this.renderConnectButton(container);
        }
    },

    renderConnectButton(container) {
        container.innerHTML = `
            <button id="wallet-connect-btn" class="wallet-btn solana-login-btn" onclick="XETE_AUTH.connect()" type="button">
                ${SOL_LOGO_SVG}
                <span>login</span>
            </button>
            <span id="wallet-error" class="wallet-error"></span>
        `;
    },

    renderConnected(container, session) {
        const shortPub = session.pubkey
            ? session.pubkey.slice(0, 4) + '…' + session.pubkey.slice(-4)
            : 'unknown';
        let label;
        if (session.alias && session.alias_status === 'granted') {
            label = `<span class="wallet-domain">%${session.alias}</span>`;
        } else if (session.alias && session.alias_status === 'pending') {
            label = `<span class="wallet-pubkey" title="Alias pending: %${session.alias}">%${session.alias} · pending</span>`;
        } else if (session.sol_domain) {
            label = `<span class="wallet-domain">${session.sol_domain}</span>`;
        } else {
            label = `<span class="wallet-pubkey">${shortPub}</span>`;
        }

        container.innerHTML = `
            <div class="wallet-connected">
                <div class="wallet-info" onclick="XETE_AUTH.toggleDropdown(event)">
                    ${label}
                    ${CARET_SVG}
                </div>
                <div id="wallet-dropdown" class="wallet-dropdown" style="display:none">
                    <div class="dropdown-item dropdown-readonly" style="opacity:0.6;cursor:default">${shortPub}</div>
                    <hr class="dropdown-sep">
                    <div class="dropdown-item" onclick="XETE_AUTH.copyAddress()">Copy address</div>
                    <div class="dropdown-item" onclick="XETE_AUTH.viewOnExplorer()">View on Solscan</div>
                    <div class="dropdown-item" onclick="location.href='/inbox'">Open inbox</div>
                    <div class="dropdown-item" onclick="location.href='/agent'">Agent portal</div>
                    <hr class="dropdown-sep">
                    <div class="dropdown-item dropdown-logout" onclick="XETE_AUTH.logout()">Disconnect</div>
                </div>
            </div>
        `;
    },

    // Show a toast-style message that's visible even on mobile, hovers
    // over the page so it's not affected by scroll position or button placement.
    showToast(msg, kind) {
        let t = document.getElementById('xete-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'xete-toast';
            t.style.cssText =
                'position:fixed;left:50%;top:1rem;transform:translateX(-50%);' +
                'background:rgba(15,23,42,0.98);color:#fff;padding:0.75rem 1rem;' +
                'border-radius:0.5rem;box-shadow:0 4px 24px rgba(0,0,0,0.5);' +
                'z-index:10000;max-width:90vw;font:14px/1.4 -apple-system,system-ui,sans-serif;' +
                'border:1px solid rgba(255,255,255,0.1);text-align:center;';
            document.body.appendChild(t);
        }
        t.style.color = kind === 'err' ? '#fda4af' : (kind === 'ok' ? '#86efac' : '#fff');
        t.textContent = msg;
        t.style.display = 'block';
        clearTimeout(t._hideTimer);
        t._hideTimer = setTimeout(() => { t.style.display = 'none'; }, 6000);
    },

    setStep(label) {
        this._step++;
        // Silent — toast popup is obscured by Phantom sign-message window on mobile
        console.log('[wallet]', this._step, label);
    },

    // True on iOS/Android (incl. iPadOS, which reports as "Macintosh" but has touch).
    // These are the ONLY platforms where the Phantom deeplink round-trip is correct;
    // on desktop the deeplink dead-ends on the phantom.app homepage.
    _isMobile() {
        const ua = navigator.userAgent || '';
        const iOSlike = /iPhone|iPad|iPod/i.test(ua)
            || (/Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1);
        return iOSlike || /Android/i.test(ua);
    },

    // Safari (desktop or iOS), excluding Chromium/Firefox families. Phantom has NO
    // Safari extension, so desktop Safari can never have an injected provider.
    _isSafari() {
        const ua = navigator.userAgent || '';
        return /Safari/i.test(ua)
            && !/Chrome|Chromium|CriOS|Edg|EdgiOS|Firefox|FxiOS|OPR|OPiOS/i.test(ua);
    },

    async connect() {
        this._step = 0;
        try {
            this.setStep('Looking for Solana wallet…');

            const provider = window.solana || (window.phantom && window.phantom.solana);
            if (!provider) {
                if (this._isMobile()) {
                    // Mobile (iOS/Android): no injected wallet. Use the Phantom deeplink
                    // ROUND-TRIP (connect -> signMessage) which redirects BACK to the
                    // browser, so the auth cookie lands HERE instead of being trapped in
                    // Phantom's in-app webview. Routed through the signing engine.
                    this.showToast('Opening Phantom to sign in…', '');
                    return this.requestSign('login', null, {});
                }
                // DESKTOP with no injected wallet: do NOT deeplink — on desktop the
                // Phantom deeplink dead-ends on the phantom.app homepage (the connect
                // bug). Show an actionable message instead. Safari can NEVER have the
                // extension; other desktop browsers just need it installed.
                const dl = 'https://phantom.app/download';
                const text = this._isSafari()
                    ? "Phantom isn't available on Safari. Open xete.net in Chrome, Brave, Firefox, or Edge with the Phantom extension to connect."
                    : "No Solana wallet found. Install the Phantom extension (Chrome, Brave, Firefox, or Edge), then reload to connect.";
                const errEl = document.getElementById('wallet-error');
                if (errEl) {
                    errEl.innerHTML = (this._isSafari()
                        ? "Phantom isn't available on Safari. Open xete.net in Chrome, Brave, Firefox, or Edge with the "
                        : "No Solana wallet found. Install the ")
                        + '<a href="' + dl + '" target="_blank" rel="noopener">Phantom extension</a>'
                        + (this._isSafari() ? " to connect." : ", then reload to connect.");
                    errEl.style.display = 'block';
                }
                this.showToast(text, 'err');
                return;
            }

            this.setStep('Wallet detected. Requesting connect…');
            const resp = await provider.connect();
            const pubkey = resp.publicKey.toString();
            this.setStep(`Connected: ${pubkey.slice(0,4)}…${pubkey.slice(-4)}`);

            this.setStep('Fetching challenge from server…');
            const challenge = await fetch(`${this.API_BASE}/auth/challenge`).then(r => r.json());
            if (!challenge || !challenge.message) throw new Error('Bad challenge response from /auth/challenge');

            this.setStep('Signing message in wallet…');
            const message = new TextEncoder().encode(challenge.message);
            // NOTE: do NOT pass a second 'utf8' arg — modern Phantom rejects it
            const signed = await provider.signMessage(message);

            // signMessage can return either { signature: Uint8Array } or just Uint8Array
            const sigBytes = signed && signed.signature ? signed.signature : signed;
            if (!sigBytes || !sigBytes.length) throw new Error('Signature empty');

            // base64-encode the signature bytes
            const sigArray = Array.from(sigBytes);
            const signature = btoa(String.fromCharCode.apply(null, sigArray));

            this.setStep('Verifying signature with server…');
            const result = await fetch(`${this.API_BASE}/auth/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pubkey, signature, nonce: challenge.nonce, invite_code: XETE_AUTH._inviteCode() }),
                credentials: 'include'
            }).then(r => r.json());

            if (result.status === 'ok') {
                XETE_AUTH._lsDel('xete_invite_code'); // consumed — don't reuse on next sign-in
                this.showToast('Signed in! Reloading…', 'ok');
                setTimeout(() => window.location.reload(), 800);
            } else if (result.code === 'INVITE_REQUIRED') {
                // Reached /inbox without a code (skipped the landing gate). Don't prompt()
                // (John's call) — route them to the single code-entry UI on the home page.
                throw new Error('xete is invite-only right now. Enter your invite code on the xete.net home page, then return here to sign in.');
            } else {
                throw new Error(result.detail || result.error || 'Authentication rejected by server');
            }
        } catch (err) {
            const msg = (err && (err.message || String(err))) || 'unknown';
            console.error('[wallet] connect failed at step', this._step, err);
            // 4001 = user rejected in Phantom
            if (err && (err.code === 4001 || /reject|denied|cancel/i.test(msg))) {
                this.showToast('Cancelled.', 'err');
            } else {
                this.showToast(`Login failed (step ${this._step}): ${msg}`, 'err');
            }
        }
    },

    async getSession() {
        try {
            const r = await fetch(`${this.API_BASE}/auth/session`, { credentials: 'include' });
            return await r.json();
        } catch {
            return { authenticated: false };
        }
    },

    async logout() {
        await fetch(`${this.API_BASE}/auth/logout`, {
            method: 'POST',
            credentials: 'include'
        });
        window.location.reload();
    },

    toggleDropdown(e) {
        if (e) e.stopPropagation();
        const dd = document.getElementById('wallet-dropdown');
        if (!dd) return;
        const show = dd.style.display === 'none';
        dd.style.display = show ? 'block' : 'none';
        if (show) {
            const close = (ev) => {
                if (!dd.contains(ev.target)) {
                    dd.style.display = 'none';
                    document.removeEventListener('click', close);
                }
            };
            setTimeout(() => document.addEventListener('click', close), 0);
        }
    },

    async copyAddress() {
        const session = await this.getSession();
        if (session.pubkey) {
            await navigator.clipboard.writeText(session.pubkey);
            this.flashDropdownItem('Copied!');
        }
    },

    viewOnExplorer() {
        this.getSession().then(s => {
            if (s.pubkey) {
                window.open(`https://solscan.io/account/${s.pubkey}`, '_blank', 'noopener');
            }
        });
    },

    flashDropdownItem(msg) {
        const dd = document.getElementById('wallet-dropdown');
        if (!dd) return;
        const item = dd.querySelector('.dropdown-item');
        if (!item) return;
        const orig = item.textContent;
        item.textContent = msg;
        setTimeout(() => { item.textContent = orig; }, 900);
    },

    showError(msg) {
        // Legacy method — route to toast for visibility
        this.showToast(msg, 'err');
    },

    // ═════════════════════════════════════════════════════════════════════════
    // Phantom mobile deeplink engine — ONE reusable signing path for the WHOLE
    // site (login, inbox messaging-key derivation, register/alias-claim, future
    // vault). Desktop & in-Phantom-webview sign via the injected provider inline;
    // mobile Safari (no injection) uses an encrypted connect->signMessage ROUND-TRIP
    // that redirects back to Safari so the result lands here, not in Phantom's webview.
    // All cross-redirect state is in localStorage (survives the iOS app-switch).
    //
    // To add a new signing action: register an intent handler in `_intents` and call
    //   XETE_AUTH.requestSign('<intent>', messageBytesOrNull, ctx)
    // ═════════════════════════════════════════════════════════════════════════

    DL: {
        CONNECT_URL: 'https://phantom.app/ul/v1/connect',
        SIGN_URL:    'https://phantom.app/ul/v1/signMessage',
        APP_URL:     'https://xete.net',
        CLUSTER:     'mainnet-beta',
        REDIRECT_BASE: 'https://xete.net/inbox',
        K_KEYPAIR: 'xete_dl_keypair',   // {pk,sk} b58 — ephemeral dapp x25519 keypair
        K_SHARED:  'xete_dl_shared',    // b58 shared secret (reused -> no re-connect)
        K_SESSION: 'xete_dl_session',   // Phantom session token from connect
        K_PUBKEY:  'xete_dl_pubkey',    // connected wallet pubkey (b58)
        K_PENDING: 'xete_dl_pending',   // {intent, ctx, msg(b58|null)} in-flight
        K_DEBUG:   'xete_dl_debug',     // persistent debug trail (survives redirects)
    },

    // Intent handlers run AFTER a successful signature; each does the intent's
    // server/client step. Phase 2 adds msgkey/register/alias/vault here — all reuse
    // the same round-trip engine, so they cost no new redirect plumbing.
    _intents: {
        login: async function (sigBytes, pubkey, ctx) {
            const signature = XETE_AUTH._b64(sigBytes);
            const result = await fetch(XETE_AUTH.API_BASE + '/auth/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pubkey: pubkey, signature: signature, nonce: ctx.nonce, invite_code: XETE_AUTH._inviteCode() }),
                credentials: 'include'
            }).then(function (r) { return r.json(); });
            if (!result || result.status !== 'ok') {
                throw new Error((result && (result.detail || result.error)) || 'Authentication rejected by server');
            }
            XETE_AUTH._lsDel('xete_invite_code'); // consumed — don't reuse on next sign-in
            return true; // cookie now set in THIS browser (Safari)
        },
        // Messaging-key derivation: on mobile (no injected wallet) the inbox can't sign
        // the derivation string inline, so it routes through this deeplink. We hand the
        // raw ed25519 signature to the inbox e2e module, which derives x25519=SHA256(sig)
        // + caches + registers — identical to desktop / House Elf / xete-mcp. ed25519 is
        // deterministic, so the deeplink-derived key matches every other client.
        msgkey: async function (sigBytes, pubkey, ctx) {
            XETE_AUTH._lsSet('xete_msgkey_sig', { sig: XETE_AUTH._b64(sigBytes), pubkey: pubkey });
            return true;
        },
    },

    // PUBLIC reusable primitive. `messageBytes` Uint8Array to sign, or null for the
    // login flow (it fetches a fresh server challenge itself). Desktop resolves inline;
    // mobile navigates to Phantom and resumes on return (does NOT resolve in-page).
    async requestSign(intent, messageBytes, ctx) {
        ctx = ctx || {};
        const provider = window.solana || (window.phantom && window.phantom.solana);
        if (provider) {
            // Desktop / in-Phantom-webview: direct + inline.
            if (!provider.publicKey) await provider.connect();
            const pubkey = provider.publicKey.toString();
            let msg = messageBytes;
            if (!msg && intent === 'login') {
                const ch = await fetch(this.API_BASE + '/auth/challenge').then(function (r) { return r.json(); });
                if (!ch || !ch.message) throw new Error('Bad challenge response');
                ctx.nonce = ch.nonce;
                msg = new TextEncoder().encode(ch.message);
            }
            const signed = await provider.signMessage(msg);
            const sigBytes = signed && signed.signature ? signed.signature : signed;
            const ok = await this._intents[intent](sigBytes, pubkey, ctx);
            if (ok && intent === 'login') { this.showToast('Signed in! Reloading…', 'ok'); setTimeout(function () { location.reload(); }, 600); }
            return ok;
        }
        // Mobile Safari: deeplink round-trip.
        if (!this._nacl()) throw new Error('crypto not loaded (tweetnacl)');
        this._lsSet(this.DL.K_PENDING, { intent: intent, ctx: ctx, msg: messageBytes ? this._b58(messageBytes) : null });
        // NOTE: the buttery "skip connect if cached" shortcut is TEMPORARILY DISABLED while
        // we diagnose the iOS return leg — always do a clean connect so there is ONE code
        // path and stale/partial cached state can never throw before navigation (which would
        // hang the tap, since connect() returns this promise unawaited). Re-enable once the
        // round-trip is confirmed end-to-end on device.
        this._dlLog('requestSign(' + intent + '): clean connect (buttery-skip disabled for debug)');
        return this._dlConnect();
    },

    // iOS Safari will NOT open an app from a SCRIPT-initiated navigation to a universal link
    // (window.location = phantom.app/ul/...) — it only opens the app from a genuine user TAP on a
    // link. So render a prominent tappable link instead of auto-navigating. (Desktop has an injected
    // wallet and never reaches the deeplink path.)
    _dlGo(url, label) {
        try {
            let ov = document.getElementById('xete-dl-go');
            if (!ov) { ov = document.createElement('div'); ov.id = 'xete-dl-go'; document.body.appendChild(ov); }
            ov.style.cssText = 'position:fixed;inset:0;z-index:100001;background:#020617;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;font-family:system-ui,-apple-system,sans-serif';
            ov.innerHTML =
                '<div style="color:#e2e8f0;font-size:15px;margin-bottom:18px;max-width:320px;line-height:1.5">Tap to open Phantom and ' + (label || 'continue') + '.</div>'
                + '<a href="' + url + '" style="background:#7c3aed;color:#fff;padding:15px 30px;border-radius:12px;font-weight:700;font-size:17px;text-decoration:none">Open Phantom &rarr;</a>'
                + '<div style="color:#64748b;font-size:12px;margin-top:18px;max-width:300px;line-height:1.5">If nothing opens, the Phantom app may not be installed, or this wallet isn’t imported in Phantom.</div>'
                + '<button onclick="this.parentNode.remove()" style="margin-top:22px;background:none;border:1px solid #334155;color:#94a3b8;padding:8px 16px;border-radius:8px;font-size:13px">Cancel</button>';
        } catch (e) { window.location.href = url; }
    },

    _dlConnect() {
        const nacl = this._nacl();
        if (!nacl) { this._dlLog('connect: nacl NOT loaded -> abort'); this.showToast('Crypto not loaded; reload and retry.', 'err'); return; }
        // Fresh handshake: drop any stale shared/session/pubkey so we never mix old state
        // with a new keypair (a prime cause of hangs/strands on a second attempt).
        this._lsDel(this.DL.K_SHARED); this._lsDel(this.DL.K_SESSION); this._lsDel(this.DL.K_PUBKEY);
        const kp = nacl.box.keyPair();
        this._lsSet(this.DL.K_KEYPAIR, { pk: this._b58(kp.publicKey), sk: this._b58(kp.secretKey) });
        const params = new URLSearchParams({
            dapp_encryption_public_key: this._b58(kp.publicKey),
            cluster: this.DL.CLUSTER,
            app_url: this.DL.APP_URL,
            redirect_link: this.DL.REDIRECT_BASE + '?xdl=connect'
        });
        this._dlLog('connect:show tap-link -> Phantom (redirect_link=' + this.DL.REDIRECT_BASE + '?xdl=connect)');
        this._dlGo(this.DL.CONNECT_URL + '?' + params.toString(), 'connect your wallet');
    },

    async _dlSign() {
        const nacl = this._nacl();
        const sharedRaw = this._lsGet(this.DL.K_SHARED);
        const session = this._lsGet(this.DL.K_SESSION);
        const kp = this._lsGet(this.DL.K_KEYPAIR);
        const pending = this._lsGet(this.DL.K_PENDING) || {};
        // Robustness: if any cached piece is missing/invalid we cannot build a valid
        // signMessage deeplink — reconnect instead of throwing (a throw here would hang
        // the tap, since the caller does not await this promise).
        if (!nacl || !kp || !kp.pk || !sharedRaw || !session) {
            this._dlLog('sign: incomplete state (kp=' + !!kp + ' shared=' + !!sharedRaw + ' session=' + !!session + ') -> reconnect');
            return this._dlConnect();
        }
        const shared = this._b58d(sharedRaw);
        let msgBytes;
        if (pending.msg) {
            msgBytes = this._b58d(pending.msg);
        } else if (pending.intent === 'login') {
            const ch = await fetch(this.API_BASE + '/auth/challenge').then(function (r) { return r.json(); });
            if (!ch || !ch.message) throw new Error('Bad challenge response');
            pending.ctx = pending.ctx || {}; pending.ctx.nonce = ch.nonce;
            this._lsSet(this.DL.K_PENDING, pending);
            msgBytes = new TextEncoder().encode(ch.message);
        } else {
            throw new Error('No message to sign for intent ' + pending.intent);
        }
        const payloadObj = { message: this._b58(msgBytes), session: session, display: 'utf8' };
        const payloadNonce = nacl.randomBytes(24);
        const boxed = nacl.box.after(new TextEncoder().encode(JSON.stringify(payloadObj)), payloadNonce, shared);
        const params = new URLSearchParams({
            dapp_encryption_public_key: kp.pk,
            nonce: this._b58(payloadNonce),
            redirect_link: this.DL.REDIRECT_BASE + '?xdl=sign',
            payload: this._b58(boxed)
        });
        this._dlLog('sign:show tap-link -> Phantom (redirect_link=' + this.DL.REDIRECT_BASE + '?xdl=sign)');
        this._dlGo(this.DL.SIGN_URL + '?' + params.toString(), 'sign');
    },

    _dlIsReturn() {
        const p = new URLSearchParams(location.search);
        const x = p.get('xdl');
        return x === 'connect' || x === 'sign';
    },

    async _dlResume() {
        const nacl = this._nacl();
        if (!nacl) throw new Error('crypto not loaded (tweetnacl)');
        const p = new URLSearchParams(location.search);
        const phase = p.get('xdl');
        if (p.get('errorCode')) {
            this._dlLog('return:' + phase + ' came back with ERROR ' + p.get('errorCode') + ' ' + (p.get('errorMessage') || ''));
            this._dlCleanUrl(); this._dlReset();
            throw new Error('Phantom: ' + (p.get('errorMessage') || p.get('errorCode')));
        }
        this._dlOverlay('Returning from Phantom…');
        if (phase === 'connect') {
            this._dlLog('return:connect LANDED in Safari. params: pub=' + !!p.get('phantom_encryption_public_key')
                + ' data=' + !!p.get('data') + ' nonce=' + !!p.get('nonce') + ' kp=' + !!this._lsGet(this.DL.K_KEYPAIR));
            const kp = this._lsGet(this.DL.K_KEYPAIR);
            if (!kp) throw new Error('Lost dapp keypair across return (localStorage)');
            const phantomPub = this._b58d(p.get('phantom_encryption_public_key'));
            const shared = nacl.box.before(phantomPub, this._b58d(kp.sk));
            const opened = nacl.box.open.after(this._b58d(p.get('data')), this._b58d(p.get('nonce')), shared);
            if (!opened) throw new Error('Could not decrypt Phantom connect payload');
            const info = JSON.parse(new TextDecoder().decode(opened));
            this._dlLog('connect:decrypted OK pubkey=' + (info.public_key || '').slice(0, 6) + '… -> chaining to sign');
            this._lsSet(this.DL.K_SHARED, this._b58(shared));
            this._lsSet(this.DL.K_SESSION, info.session);
            this._lsSet(this.DL.K_PUBKEY, info.public_key);
            this._dlCleanUrl();
            this._dlOverlay('Connected. Requesting signature…');
            await this._dlSign();   // navigates away to Phantom again
            return;
        }
        if (phase === 'sign') {
            this._dlLog('return:sign LANDED in Safari. params: data=' + !!p.get('data') + ' nonce=' + !!p.get('nonce')
                + ' shared=' + !!this._lsGet(this.DL.K_SHARED));
            const shared = this._b58d(this._lsGet(this.DL.K_SHARED));
            if (!shared || !shared.length) throw new Error('Lost shared secret across return (localStorage)');
            const opened = nacl.box.open.after(this._b58d(p.get('data')), this._b58d(p.get('nonce')), shared);
            if (!opened) throw new Error('Could not decrypt Phantom signature payload');
            const res = JSON.parse(new TextDecoder().decode(opened));
            const sigBytes = this._b58d(res.signature);
            const pubkey = this._lsGet(this.DL.K_PUBKEY);
            const pending = this._lsGet(this.DL.K_PENDING) || {};
            const handler = this._intents[pending.intent];
            this._dlCleanUrl();
            this._lsDel(this.DL.K_PENDING);
            if (!handler) throw new Error('No handler for intent ' + pending.intent);
            this._dlLog('sign:decrypted OK -> running intent ' + pending.intent + ' (POST /auth/verify)');
            const ok = await handler(sigBytes, pubkey, pending.ctx || {});
            this._dlLog('intent ' + pending.intent + ' result=' + ok + ' -> COOKIE SET IN SAFARI. (You are logged in here.)');
            if (ok && (pending.intent === 'login' || pending.intent === 'msgkey')) {
                this._dlOverlay(pending.intent === 'msgkey'
                    ? 'Encrypted messaging unlocked. Loading…'
                    : 'Signed in! Loading your inbox…');
                setTimeout(function () { location.reload(); }, 500);
            } else {
                this._dlOverlayHide();
            }
            return;
        }
    },

    // Clear in-flight deeplink state (keep shared secret/session for buttery reuse).
    _dlReset() { this._lsDel(this.DL.K_PENDING); this._lsDel(this.DL.K_KEYPAIR); },
    // Full disconnect of the deeplink session.
    _dlForget() { this._dlReset(); this._lsDel(this.DL.K_SHARED); this._lsDel(this.DL.K_SESSION); this._lsDel(this.DL.K_PUBKEY); },

    _dlCleanUrl() { try { history.replaceState(null, '', location.pathname); } catch (e) {} },

    _dlOverlay(text) {
        let o = document.getElementById('xete-dl-overlay');
        if (!o) {
            o = document.createElement('div');
            o.id = 'xete-dl-overlay';
            o.style.cssText = 'position:fixed;inset:0;z-index:10001;display:flex;align-items:center;'
                + 'justify-content:center;flex-direction:column;gap:1rem;background:#020617;color:#e0e0e0;'
                + 'font:15px/1.5 -apple-system,system-ui,sans-serif;text-align:center;padding:2rem';
            o.innerHTML = '<div style="width:34px;height:34px;border:3px solid #1e293b;border-top-color:#22d3ee;'
                + 'border-radius:50%;animation:xeteSpin 0.8s linear infinite"></div><div id="xete-dl-text"></div>';
            const st = document.createElement('style');
            st.textContent = '@keyframes xeteSpin{to{transform:rotate(360deg)}}';
            document.head.appendChild(st);
            document.body.appendChild(o);
        }
        const t = document.getElementById('xete-dl-text'); if (t) t.textContent = text || 'Working…';
        o.style.display = 'flex';
    },
    _dlOverlayHide() { const o = document.getElementById('xete-dl-overlay'); if (o) o.style.display = 'none'; },

    // ── debug trail (enable with ?dldebug=1; persists across redirects) ──
    _dlDebugOn() { try { return localStorage.getItem('xete_dl_debug_on') === '1'; } catch (e) { return false; } },
    _dlLog(msg) {
        try {
            const arr = this._lsGet(this.DL.K_DEBUG) || [];
            const ts = new Date().toISOString().slice(11, 23);
            arr.push(ts + '  ' + msg);
            while (arr.length > 40) arr.shift();
            this._lsSet(this.DL.K_DEBUG, arr);
        } catch (e) {}
        try { console.log('[xete-dl]', msg); } catch (e) {}
        this._dlRenderDebug();
    },
    _dlRenderDebug() {
        if (!this._dlDebugOn()) return;
        let d = document.getElementById('xete-dl-debug');
        if (!d) {
            d = document.createElement('div');
            d.id = 'xete-dl-debug';
            d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:10002;max-height:45vh;overflow:auto;'
                + 'background:#000;color:#39ff14;font:11px/1.45 ui-monospace,monospace;padding:8px 10px;'
                + 'white-space:pre-wrap;word-break:break-word;border-top:2px solid #39ff14';
            document.addEventListener('DOMContentLoaded', function () { if (!d.parentNode) document.body.appendChild(d); });
            if (document.body) document.body.appendChild(d);
        }
        const arr = this._lsGet(this.DL.K_DEBUG) || [];
        d.textContent = 'XETE DEEPLINK DEBUG — tap to copy, double-tap to clear\n' + arr.join('\n');
        d.onclick = function () { try { navigator.clipboard.writeText(arr.join('\n')); } catch (e) {} };
        d.ondblclick = function () { try { localStorage.removeItem('xete_dl_debug'); } catch (e) {} d.textContent = '(cleared)'; };
    },

    // ── small helpers ──
    // Invite code carried into first-time registration. Stored as a PLAIN string under
    // 'xete_invite_code' by either (a) the landing gate on a valid non-consuming check, or
    // (b) the inbox's own code prompt. Returns undefined when absent so the field is omitted
    // (the server treats absent + invalid identically: 403 only when INVITE_GATE_REQUIRED).
    _inviteCode() { try { const c = (localStorage.getItem('xete_invite_code') || '').trim(); return c || undefined; } catch (e) { return undefined; } },
    _nacl() { return window.nacl || null; },
    _lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    _lsGet(k) { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } },
    _lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} },
    _b64(bytes) { return btoa(String.fromCharCode.apply(null, Array.from(bytes))); },
    _b58(bytes) { return XETE_B58.encode(bytes); },
    _b58d(str) { return XETE_B58.decode(str); }
};

// Auto-init
document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('wallet-connect');
    if (el) XETE_AUTH.init('wallet-connect');
});

// Expose globally
window.XETE_AUTH = XETE_AUTH;

