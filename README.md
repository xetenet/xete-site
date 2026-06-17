# xete — public site, with a verifiable integrity guarantee

This repo is the **canonical source** of the public [xete.net](https://xete.net) site. It exists so
anyone can confirm the site you're served is the site we published — *don't trust us, verify.*

## How the verification works

Two independent layers, both reporting to one place:

1. **Global drift monitor (this repo).** A GitHub Action (`.github/workflows/verify.yml`) runs every
   15 minutes (and on every commit): it fetches each live page from xete.net, hashes it, and compares
   it to the version committed here. If the live site ever stops matching this repo, the run **fails
   loudly** and POSTs the mismatch to `https://xete.net/integrity/report` — which raises a **red alarm
   on our admin dashboard** in real time. So a wholesale tamper of the live site is caught within
   minutes, in public, with a permanent record (the repo's git history + the failed run).

2. **Per-visitor browser tripwire.** Every page is served with a Content-Security-Policy whose
   `report-uri` points at `/integrity/report`. If an attacker injects code into *your specific*
   browser session (a MITM, a poisoned CDN, a regional injection — things a single-vantage checker
   can't see), **your browser itself** reports it to us — and that report can't be stripped by the
   page's own code, because the browser does the reporting, not our JavaScript.

Together: layer 1 watches the whole site globally; layer 2 catches targeted, per-visitor injection.

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
  copy. That's exactly what layer 2 (the browser CSP tripwire) is for.
- A full compromise of our origin server could, in theory, mute one visitor's in-page reporter — but
  the browser-native CSP report is hard to strip, and any auditor (or our own future verify extension)
  re-running the hash check above always catches it.

## Workflow

Edit a page -> deploy to xete.net -> commit the new version here. The Action keeps live and repo in
lockstep; any gap (a tamper, or a forgotten commit) trips the alarm.
