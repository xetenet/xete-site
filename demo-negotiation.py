#!/usr/bin/env python3
"""
THE NEGOTIATION DEMO — the messaging half, run for real.

Per 06-NEGOTIATION-DEMO.md section 7: record the messaging half now, hold the settlement
half until one small real mainnet settlement has actually been run. This script does the
messaging half ONLY. It never drafts, verifies, signs or submits a transaction, and it
must never be edited to narrate a settlement that has not happened.

WHAT IT PROVES, and how:
  Two identities are generated locally, on this machine, with no signup and no wallet.
  They negotiate a price. Every message is sealed to the recipient's key BEFORE it
  leaves the process, and this script prints the EXACT request body handed to the
  transport — not a reconstruction of it — so you can read what the relay actually
  receives. The plaintext never appears in it.

  That is the whole claim, and it is checkable by anyone who runs this.

Identities are written to a scratch directory, NOT ~/.xete, so running this cannot
disturb an existing identity on the machine.

Usage:  python demo-negotiation.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

try:
    from xete_mcp.client import XeteClient, load_or_create_identity
except ImportError:
    sys.exit("xete-mcp is not installed.  pip install xete-mcp   (or: uvx xete-mcp)")


# The negotiation. Deliberately mundane — the point is not the deal, it is what the
# relay can see of it.
SCRIPT = [
    ("ana", "the 3 SOL one - I'll do 2.4"),
    ("ben", "2.7 and it's done"),
    ("ana", "2.55. final."),
    ("ben", "done"),
]

BAR = "-" * 78


def banner(t: str) -> None:
    print(f"\n{BAR}\n{t}\n{BAR}")


def wire_capture(client: XeteClient, sink: list) -> None:
    """Wrap the client's single transport chokepoint so we record the REAL request
    body rather than rebuilding what we think it sends. A demo that prints a
    reconstruction is not evidence of anything."""
    original = client._req

    def traced(method, path, **kw):
        if "send" in path and "json" in kw:
            sink.append((path, kw["json"]))
        return original(method, path, **kw)

    client._req = traced


BASE_URL = os.environ.get("XETE_SERVER_URL", "https://xete.net")

# Reused across runs ON PURPOSE. Minting a fresh pair every run registers a new agent
# on the relay each time and reliably trips the auth rate limit — which is anti-abuse
# working correctly, not a bug to route around. Pass --fresh only when you actually
# want new identities (e.g. recording the "no signup" beat on camera).
DEMO_HOME = Path(os.environ.get("XETE_DEMO_HOME", Path.home() / ".xete-demo"))


def make_party(name: str, root: Path, attempts: int = 4) -> XeteClient:
    ident = load_or_create_identity(root / f"{name}.json")
    c = XeteClient(base_url=BASE_URL, identity=ident)
    last = None
    for i in range(attempts):
        try:
            c.login()
            c.register_encryption_key()
            return c
        except Exception as e:  # noqa: BLE001 — we re-raise below with context
            last = e
            if "429" not in str(e):
                raise
            wait = 5 * (2 ** i)
            print(f"  rate limited creating {name}; waiting {wait}s "
                  f"(attempt {i + 1}/{attempts})")
            time.sleep(wait)
    raise SystemExit(
        f"\nStill rate limited after {attempts} attempts: {last}\n"
        "The relay is throttling auth. Re-run WITHOUT --fresh so the demo reuses its\n"
        "existing identities instead of registering new ones.")


def main() -> int:
    fresh = "--fresh" in sys.argv
    root = Path(tempfile.mkdtemp(prefix="xete-demo-")) if fresh else DEMO_HOME
    root.mkdir(parents=True, exist_ok=True)
    print(f"identities: {root}"
          f"{'  (fresh — registers new agents)' if fresh else '  (reused; --fresh to mint new)'}")
    print("your own ~/.xete identity is untouched either way")

    banner("1. TWO PARTIES.  Generated locally. No signup, no email, no wallet.")
    parties, wires = {}, []
    for who in ("ana", "ben"):
        c = make_party(who, root)
        wire_capture(c, wires)
        parties[who] = c
        print(f"  {who:4s}  agent_id {c.identity.agent_id}")
        print(f"        pubkey   {c.identity.pubkey_b58}")

    banner("2. THE NEGOTIATION.  What each party sees.")
    # Identities are reused across runs, so the inbox accumulates. Snapshot the message
    # IDs already present and show only what is NEW — a transcript padded with earlier
    # runs looks like a bug and undermines the one thing this script is for. Timestamps
    # are not good enough here: two runs back to back land in the same second.
    seen_before = {m.get("id") for m in parties["ben"].inbox(limit=50)}
    for who, text in SCRIPT:
        other = "ben" if who == "ana" else "ana"
        parties[who].send_multi(parties[other].identity.agent_id, text)
        print(f"  {who:4s} -> {other:4s}   {text}")

    banner("3. WHAT ACTUALLY LEFT THE MACHINE.  The real request body, captured at the\n"
           "   transport. This is everything the relay receives.")
    leaked = []
    for path, body in wires:
        rec = body["recipients"][0]
        blob = rec["encrypted_content"]
        nonce_b64, ct_b64 = blob.split(":", 1)
        print(f"\n  POST {path}")
        print(f"    to               {rec['to']}")
        print(f"    nonce            {nonce_b64}")
        print(f"    encrypted_content{'':1s}{ct_b64[:64]}…")
        print(f"    content_hash     {rec['content_hash'][:32]}…")
        # prove no plaintext survives anywhere in the serialized body
        flat = json.dumps(body)
        for _, text in SCRIPT:
            if text in flat:
                leaked.append(text)

    banner("4. THE CHECK.  Does any plaintext appear in what we sent?")
    if leaked:
        print("  ** PLAINTEXT LEAKED — the demo's central claim is FALSE **")
        for t in leaked:
            print(f"     {t!r}")
        return 1
    print(f"  {len(wires)} request bodies inspected.")
    print("  0 of the negotiation's words appear in any of them.")
    print("  The relay carries ciphertext and routing metadata. It cannot read the deal.")

    banner("5. AND YET BEN CAN READ IT.  Only his key opens it.\n"
           "   Same bytes as above, decrypted on his machine with his key.")
    expected = sum(1 for who, _ in SCRIPT if who == "ana")
    inbox = parties["ben"].inbox(limit=50)
    this_run = [m for m in inbox
                if m.get("text") and m.get("id") not in seen_before]
    for msg in reversed(this_run):
        print(f"  ben's inbox <- {msg['from'][:8]}…   {msg['text']}")

    if not this_run:
        print("  ** nothing from this run — the recipient could not read what we sent **")
        return 1
    if len(this_run) != expected:
        print(f"\n  note: expected {expected} messages from this run, showing {len(this_run)}.")

    banner("WHAT THE RELAY CAN STILL SEE.  Stated plainly, because a demo that only\n"
           "   shows the good half is an advertisement.")
    print("  It cannot read the deal. It CAN see: who sent to whom, when, and roughly")
    print("  how long each message was — the ciphertext lengths above track the")
    print("  plaintext lengths. Traffic analysis is not defeated by encryption alone.")
    print("  If message size matters to you, pad. We do not pad these for you.")

    banner("WHAT THIS DEMO DOES NOT SHOW")
    print("  No settlement. No transaction was drafted, verified, signed or submitted.")
    print("  As of 2026-08-03 no settlement has been run end to end on mainnet, so this")
    print("  demo deliberately stops at the negotiation. The settlement half gets recorded")
    print("  when it has actually been done once for real, and not before.")
    print()
    print("  The negotiation is nobody's business. The settlement is everybody's.")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
