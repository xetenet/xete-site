/* nav-auth.js — make the static site's nav reflect whether you're logged in.
   Honest signal: /auth/session (per-request, no caching). Idempotent + defensive:
   if the call fails or you're logged out, the page is left exactly as authored.
   When logged in:
     - nav Log in  -> Inbox  (larger, soft green glow — not a solid button)
     - nav Register -> Log out
     - the big body "Get started / Open your inbox" button is hidden; the glowing
       corner link is the way in. */
(function () {
  function tail(href) {
    if (!href) return '';
    return href.split('?')[0].split('#')[0].replace(/\/+$/, '');
  }
  function isLogin(t) { return t === '/login' || t.endsWith('/login'); }
  function isRegister(t) { return t === '/register' || t.endsWith('/register'); }

  function inNav(a) {
    return !!(a.closest && a.closest('.bar, .nav, .topnav, header')) ||
      a.classList.contains('login') || a.classList.contains('reg') ||
      a.classList.contains('register');
  }

  function logout(e) {
    e.preventDefault();
    fetch('/auth/logout', { method: 'POST', credentials: 'include' })
      .catch(function () {})
      .then(function () { location.href = '/home'; });
  }

  function injectStyle() {
    if (document.getElementById('navauth-style')) return;
    var st = document.createElement('style');
    st.id = 'navauth-style';
    st.textContent =
      '.xinbox-live{color:#6ee7b7!important;font-weight:700;font-size:1.12em;' +
      'letter-spacing:.2px;text-shadow:0 0 9px rgba(110,231,183,.6);' +
      'border-color:rgba(110,231,183,.55)!important;animation:none!important;}' +
      '.xinbox-live:hover{color:#a7f3d0!important;text-shadow:0 0 14px rgba(110,231,183,.85);}';
    document.head.appendChild(st);
  }

  fetch('/auth/session', { credentials: 'include', cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (s) {
      if (!s || !s.authenticated) return;
      injectStyle();

      // Nav: Log in -> Inbox (glow), Register -> Log out.
      var links = document.querySelectorAll('.bar a, .nav a, .topnav a, header a, a.login, a.reg, a.register');
      Array.prototype.forEach.call(links, function (a) {
        if (!inNav(a)) return;
        var t = tail(a.getAttribute('href') || '');
        if (isLogin(t)) {
          a.setAttribute('href', '/inbox');
          a.textContent = 'Inbox';
          a.classList.add('xinbox-live');
        } else if (isRegister(t)) {
          a.setAttribute('href', '#');
          a.textContent = 'Log out';
          a.addEventListener('click', logout);
        }
      });

      // Logged in: drop the big body "Get started / Register" CTAs (incl. the green
      // button and register sub-links). The glowing nav Inbox link is the way in.
      var ctas = document.querySelectorAll('a.go, a.btn, a.cta, a.primary, a.action, a.tour');
      Array.prototype.forEach.call(ctas, function (g) {
        if (inNav(g)) return;
        if (isRegister(tail(g.getAttribute('href') || ''))) g.style.display = 'none';
      });
    })
    .catch(function () {});
})();
