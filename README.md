# xete — public site, with a verifiable integrity guarantee

This repo is the **canonical source** of the public [xete.net](https://xete.net) site. It exists so
anyone can confirm the site you're served is the site we published — *don't trust us, verify.*

## How the verification works

Three layers, each covering something the others can't:

1. **Global drift monitor (this repo).** A GitHub Action (`.github/workflows/verify.yml`) runs every
   15 minutes (and on every commit): it fetches each live page from xete.net, hashes it, and compares
   it to the version committed here. If the live site ever stops matching this repo, the run **fails
   loudly** and POSTs the mismatch to `https://xete.net/integrity/report` — which raises a **red alarm
   on our admin dashboard** in real time. So a wholesale tamper of the live site is caught within
   minutes, in public, with a permanent record (the repo's git history + the failed run).

2. **Per-visitor browser tripwire (CSP).** Every page is served with a Content-Security-Policy whose
   `report-uri` points at `/integrity/report`. CSP is a control on *where* code may come from: if
   something on the page pulls in code from a source the policy doesn't list — an injected
   `<script src="...">`, a payload added by a MITM or a regional injection — **your browser itself**
   tells us, and that report can't be stripped by the page's own code, because the browser does the
   reporting, not our JavaScript.

   **What this layer does not do.** It is currently served in *report-only* mode, so it is an alarm,
   not a lock: it tells us an injection happened, it doesn't stop it. And CSP never looks at the
   *contents* of a resource it is willing to fetch — if a source already on the allow-list serves a
   poisoned file, the browser sees a permitted origin and stays silent: no violation, no report. So
   a CSP `report-uri` cannot catch a poisoned CDN. That is why the sign-in pages no longer load
   anything from one, and closing that gap is layer 3's job.

3. **Pinned, self-hosted third-party code (SRI).** The one third-party library the sign-in pages
   need (tweetnacl, on `pages/login.html` and `pages/get-started.html`) is vendored into this repo
   as `js/nacl-1.0.3.min.js`, served from xete.net instead of a CDN, and its `<script>` tag carries
   a Subresource Integrity hash. The browser hashes the bytes it actually received and refuses to
   execute the file unless they match the bytes published here. Tampering with the *content* of that
   script — by us, by a host, by a proxy — fails closed instead of running. This matters more on
   those two pages than anywhere else on the site: they run PBKDF2 and AES-GCM over a passphrase, so
   swapped-in crypto code would be reading secrets.

Together: layer 1 watches the whole site globally; layer 2 alarms on code pulled from a source we
never listed; layer 3 blocks tampering with the code we did list.

## Verify it yourself

```sh
# clone, then for any page:
curl -sL --compressed https://xete.net/people | sha256sum
sha256sum pages/people.html
# the two hashes should be identical. If they aren't, the live site has drifted from this repo.
```

`routes.txt` lists every monitored route -> file. The Action is the automated version of the check above.

## Honest limits (because a security product shouldn't overclaim)

- "Matches the repo" means *matches what we published* — read the code here to judge whether the code
  itself is trustworthy. The transparency is the point: every change is a public commit.
- The Action checks from GitHub's vantage point, so a *targeted* attack could show GitHub the clean
  copy. Layer 2 covers the part of that a browser can see: code pulled in from a source the policy
  doesn't allow. It does not cover a change to the page's own served bytes, because CSP never
  compares those to anything.
- Layer 1 hashes the HTML routes listed in `routes.txt` and nothing else. Static assets (`fonts/`,
  `js/`) are **not** monitored by the Action. `js/nacl-1.0.3.min.js` is covered instead by its SRI
  hash, which every visitor's browser re-checks on every page load.
- SRI fails closed but quietly: a mismatch blocks the script and logs a console error, it does not
  POST to `/integrity/report`. Layers 1 and 2 are the ones that raise an alarm; layer 3 is the one
  that stops the code running. Don't read "no alarm" as "nothing was blocked."
- Layer 2 is only ever as strong as the policy the server actually sends, and that policy lives in
  the web server config, not in this repo — you can't audit it from a clone, you have to read the
  response headers. As deployed today it is sent as `Content-Security-Policy-Report-Only`, and its
  `script-src` includes `'unsafe-inline'` (these pages carry inline `<script>` blocks, which a
  nonce- or hash-based policy would cover more tightly). Net effect: layer 2 reports code pulled
  from a source we never listed, after the fact — it does not block, and it does not see injected
  *inline* code at all.
- A full compromise of our origin server could, in theory, mute one visitor's in-page reporter — but
  the browser-native CSP report is hard to strip, and any auditor (or our own future verify extension)
  re-running the hash check above always catches it.

## Workflow

Edit a page -> deploy to xete.net -> commit the new version here. The Action keeps live and repo in
lockstep; any gap (a tamper, or a forgotten commit) trips the alarm.

`js/nacl-1.0.3.min.js` must be deployed to `https://xete.net/js/nacl-1.0.3.min.js` and served
**byte-for-byte** as committed here: the SRI hash on the sign-in pages is computed over exactly
these bytes, so any change — a re-minification, a rewritten line ending from a text-mode file
transfer, an edit — makes every browser refuse to run it, and those pages stop working. Deploy the
script and the pages together. If the library is ever upgraded, recompute the hash and update both
`pages/login.html` and `pages/get-started.html`:

```sh
echo "sha384-$(openssl dgst -sha384 -binary js/nacl-1.0.3.min.js | openssl base64 -A)"
```

Once it is deployed, `https://cdn.jsdelivr.net` should come out of the `script-src` allow-list in
the server's CSP header — nothing on the site loads from it any more, and while it stays listed an
injected jsDelivr script is a *permitted* source and raises no report at all.

The vendored copy is tweetnacl 1.0.3 taken from the npm tarball
(`sha512-6rt+RN7aOi1nGMyC4Xa5DdYiukl2UWCbcJft7YhxReBGQD7OAM8Pbxw6YMo4r2diNEA8FEmu32YOn9rhaiE5yw==`,
the registry's published integrity for `tweetnacl-1.0.3.tgz`); the same bytes are what jsDelivr,
unpkg and cdnjs serve for that version. sha256 `973cc5733cc7432e30ee4682098f413094f494bccf76a567c23908c5035ddbbc`.
