#!/usr/bin/env python3
"""
Import public X posts through fxtwitter into data/fixtures/x_manual.json.

This is a manual/real-data importer, not the official X API. It preserves
existing Chinese annotations by tweet id when re-run.

Usage:
  python3 scripts/import_fxtwitter.py
  python3 scripts/import_fxtwitter.py data/links.txt

Input format: one URL per line, e.g.
  https://x.com/SemiAnalysis_/status/2124006824525299715
"""

from __future__ import annotations

import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from sync_x import KNOWN_TICKERS, classify_topic, score_importance, score_sentiment  # noqa: E402

TZ = timezone(timedelta(hours=8))
LINKS_FILE = ROOT / "data" / "links.txt"
FIXTURE_FILE = ROOT / "data" / "fixtures" / "x_manual.json"
NOTES_FILE = ROOT / "data" / "fixtures" / "x_manual_notes.json"
ACCOUNTS_FILE = ROOT / "data" / "accounts.json"
REQUEST_TIMEOUT = 20


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def parse_link(url: str) -> tuple[str, str] | None:
    parsed = urlparse(url.strip())
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 3 or parts[1] != "status":
        return None
    return parts[0], parts[2]


def fetch_tweet(handle: str, tweet_id: str) -> dict:
    url = f"https://api.fxtwitter.com/{handle}/status/{tweet_id}"
    request = Request(url, headers={"User-Agent": "Signal8/1.0", "Accept": "application/json"})
    last_error = None
    for attempt in range(2):
        try:
            with urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if payload.get("code") != 200 or not payload.get("tweet"):
                raise RuntimeError(f"fxtwitter code={payload.get('code')} message={payload.get('message')}")
            return payload["tweet"]
        except HTTPError as exc:
            last_error = RuntimeError(f"HTTP {exc.code}")
            if exc.code == 429 or exc.code >= 500:
                time.sleep(3)
                continue
            raise last_error
        except URLError as exc:
            last_error = RuntimeError(f"network error: {exc.reason}")
            time.sleep(1)
    raise last_error or RuntimeError("unknown fxtwitter error")


def parse_created_at(value: str) -> datetime:
    try:
        return datetime.strptime(value, "%a %b %d %H:%M:%S %z %Y").astimezone(TZ)
    except ValueError:
        return datetime.now(TZ)


def extract_tickers(tweet: dict) -> list[str]:
    found: list[str] = []
    raw = tweet.get("raw_text") or {}
    for facet in raw.get("facets") or []:
        if isinstance(facet, dict) and facet.get("type") == "symbol":
            tag = str(facet.get("original") or "").upper().strip()
            if tag:
                found.append(tag)
    for match in re.finditer(r"\$([A-Za-z0-9.]{1,10})", str(tweet.get("text") or "")):
        tag = match.group(1).upper()
        if tag in KNOWN_TICKERS or len(tag) <= 5:
            found.append(tag)
    out = []
    for tag in found:
        if tag not in out:
            out.append(tag)
    return out[:8]


def main() -> None:
    links_path = Path(sys.argv[1]) if len(sys.argv) > 1 else LINKS_FILE
    links = [line.strip() for line in links_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    accounts = load_json(ACCOUNTS_FILE, {})
    previous = load_json(FIXTURE_FILE, {"posts": []})
    previous_by_id = {str(post.get("id")): post for post in previous.get("posts", []) if post.get("id")}
    notes = load_json(NOTES_FILE, {})

    posts = []
    errors = []
    for index, link in enumerate(links, 1):
        parsed = parse_link(link)
        if not parsed:
            errors.append((link, "invalid URL"))
            continue
        handle, tweet_id = parsed
        try:
            tweet = fetch_tweet(handle, tweet_id)
        except Exception as exc:  # noqa: BLE001
            errors.append((link, str(exc)))
            print(f"[{index}/{len(links)}] ERROR {link}: {exc}", file=sys.stderr)
            continue

        author = tweet.get("author") or {}
        account = str(author.get("screen_name") or handle)
        created = parse_created_at(str(tweet.get("created_at") or ""))
        text = str(tweet.get("text") or "").strip()
        if not text:
            errors.append((link, "empty text"))
            continue
        tickers = extract_tickers(tweet)
        metrics = {
            "likes": int(tweet.get("likes", 0) or 0),
            "reposts": int(tweet.get("retweets", 0) or 0),
            "replies": int(tweet.get("replies", 0) or 0),
            "quotes": int(tweet.get("quotes", 0) or 0),
            "views": int(tweet.get("views", 0) or 0),
        }
        old = notes.get(str(tweet.get("id"))) or previous_by_id.get(str(tweet.get("id")), {})
        account_meta = accounts.get(account, {"role": "个股/事件驱动"})
        post = {
            "id": str(tweet.get("id")),
            "account": account,
            "date": created.strftime("%Y-%m-%d"),
            "time": created.strftime("%H:%M"),
            "topic": old.get("topic") or classify_topic(text, account_meta),
            "sentiment": old.get("sentiment") or score_sentiment(text),
            "importance": old.get("importance") or score_importance(metrics),
            "tickers": old["tickers"] if "tickers" in old else tickers,
            "summary": old.get("summary") or (text if len(text) <= 180 else text[:179].rstrip() + "…"),
            "text": text,
            "viewpoint": old.get("viewpoint") or "",
            "note": old.get("note") or "",
            "change": old.get("change") or "",
            "url": f"https://x.com/{account}/status/{tweet.get('id')}",
            "watch": bool(old.get("watch")),
            "metrics": metrics,
            "lang": str(tweet.get("lang") or ""),
            "source": "manual",
        }
        posts.append(post)
        preview = text.replace("\n", " ")[:100]
        print(f"[{index}/{len(links)}] @{account} {post['date']} {post['time']} {preview}")
        time.sleep(0.35)

    posts.sort(key=lambda post: (post["date"], post["time"]), reverse=True)
    payload = {
        "fetchedAt": datetime.now(TZ).isoformat(),
        "linksFile": str(links_path.relative_to(ROOT)),
        "posts": posts,
    }
    FIXTURE_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n[import] wrote {len(posts)} posts to {FIXTURE_FILE}")
    if errors:
        print(f"[import] {len(errors)} link(s) failed:", file=sys.stderr)
        for link, error in errors:
            print(f"  - {link}: {error}", file=sys.stderr)


if __name__ == "__main__":
    main()
