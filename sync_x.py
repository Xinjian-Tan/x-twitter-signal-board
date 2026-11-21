#!/usr/bin/env python3
"""
Sync X signals into data.js + data/history.json.

Modes:
  - x-api: X_BEARER_TOKEN is set and MOCK_SYNC != 1
  - mock:  no token, or MOCK_SYNC=1

The same normalization/merge/history pipeline runs in both modes.
In x-api mode the token is read from the environment only; it is never
written to disk, data.js, or the browser.

Usage:
  python3 scripts/sync_x.py
  MOCK_SYNC=1 python3 scripts/sync_x.py

Optional env:
  X_API_BASE         default https://api.x.com/2
  X_API_MAX_RESULTS  per-account tweet limit, default 10 (5-100)
  HTTPS_PROXY        urllib honors standard proxy env vars
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
ACCOUNTS_FILE = DATA_DIR / "accounts.json"
HISTORY_FILE = DATA_DIR / "history.json"
MOCK_FILE = DATA_DIR / "fixtures" / "x_mock.json"
MANUAL_FILE = DATA_DIR / "fixtures" / "x_manual.json"
OUTPUT_FILE = ROOT / "data.js"

TZ = timezone(timedelta(hours=8))
NOW = datetime.now(TZ)

MAX_HISTORY_DAYS = 90
MAX_OUTPUT_DAYS = 14
REQUEST_TIMEOUT = 20
DEFAULT_MAX_RESULTS = 10


class XApiError(RuntimeError):
    def __init__(self, status: int, body: str, retry_after: str | None = None):
        self.status = status
        self.body = body
        self.retry_after = retry_after
        super().__init__(self._message())

    def _message(self) -> str:
        if self.status == 401:
            hint = "token invalid or expired; rotate X_BEARER_TOKEN"
        elif self.status == 403:
            hint = "access denied, app permission missing, or quota/credits exhausted; check your X API plan"
        elif self.status == 429:
            hint = "rate limited; wait for the window to reset"
        elif self.status >= 500:
            hint = "X API server error; retry later"
        else:
            hint = "X API request failed; check token, plan, and parameters"
        retry = f", retry-after={self.retry_after}s" if self.retry_after else ""
        body = (self.body or "").strip()
        return f"HTTP {self.status}{retry}: {hint}. {body[:300]}".strip()


def max_results() -> int:
    raw = os.environ.get("X_API_MAX_RESULTS", str(DEFAULT_MAX_RESULTS))
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = DEFAULT_MAX_RESULTS
    return max(5, min(100, value))

TOPIC_ORDER = ["半导体/供应链", "TMT/互联网", "市场/宏观", "个股/事件驱动"]

TOPIC_KEYWORDS = {
    "半导体/供应链": [
        "semiconductor", "semis", "chip", "chips", "wafer", "foundry", "tsmc",
        "cowos", "packaging", "asml", "hbm", "dram", "nand", "memory", "euv",
        "substrate", "optical", "transceiver", "cpo", "supply chain", "capacity",
        "utilization", "node", "fab", "equipment", "lithography", "interconnect",
    ],
    "TMT/互联网": [
        "cloud", "capex", "software", "internet", "advertising", "ads", "e-commerce",
        "commerce", "china internet", "alibaba", "pdd", "tencent", "meta", "google",
        "microsoft", "amazon", "robot", "robotics", "humanoid", "physical ai",
        "ai model", "inference", "agent", "search", "streaming", "gaming",
    ],
    "市场/宏观": [
        "fed", "rate", "rates", "yield", "yields", "inflation", "liquidity", "macro",
        "dollar", "recession", "positioning", "volatility", "vix", "credit",
        "treasury", "curve", "cpi", "gdp", "risk-off", "risk on", "liquidity",
    ],
    "个股/事件驱动": [
        "earnings", "guidance", "upgrade", "downgrade", "merger", "acquisition",
        "ipo", "catalyst", "short squeeze", "buyback", "event", "announcement",
        "contract", "order", "backlog", "delivery", "shipment",
    ],
}

KNOWN_TICKERS = {
    "NVDA", "AMD", "AVGO", "TSM", "MU", "ASML", "AMAT", "LRCX", "KLAC",
    "MRVL", "AXTI", "SIVE", "AAOI", "COHR", "CRDO", "VRT", "ORCL", "MSFT",
    "GOOGL", "AMZN", "META", "TSLA", "BABA", "PDD", "JD", "SMCI", "SPX",
    "US10Y", "DXY", "VIX", "QQQ", "GLD",
}

STOP_TICKERS = {
    "AI", "GPU", "CPU", "HBM", "DRAM", "NAND", "CEO", "CFO", "IPO", "ETF",
    "GDP", "CPI", "FED", "USA", "USD", "CN", "HK", "US", "EU", "API", "LLM",
    "AGI", "SK", "TSMC", "OK", "THE", "FOR", "AND", "NOT",
}

BULL_WORDS = {
    "beat", "beats", "raise", "raised", "raises", "strong", "upside", "bullish",
    "buy", "buying", "long", "accelerate", "accelerating", "tight", "shortage",
    "demand", "record", "growth", "upgrade", "outperform", "better", "positive",
    "breakout", "momentum", "reacceleration", "sold", "soldout",
}

BEAR_WORDS = {
    "miss", "misses", "cut", "cuts", "weak", "downside", "bearish", "sell",
    "selling", "short", "glut", "oversupply", "downgrade", "underperform",
    "slowdown", "slow", "risk", "bubble", "recession", "layoffs", "worse",
    "negative", "pressure", "compression", "delay", "delays", "cancel",
}

WORD_RE = re.compile(r"[a-z]+")


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid JSON: {path} ({exc})") from exc


def write_json_atomic(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def fmt_updated(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M 北京时间")


def load_accounts() -> dict:
    accounts = load_json(ACCOUNTS_FILE, None)
    if not isinstance(accounts, dict) or not accounts:
        raise RuntimeError(f"accounts file is empty or invalid: {ACCOUNTS_FILE}")
    for handle, meta in accounts.items():
        if not isinstance(meta, dict):
            raise RuntimeError(f"invalid account metadata for {handle}")
        meta.setdefault("name", handle)
        meta.setdefault("role", "个股/事件驱动")
    return accounts


def load_history() -> dict:
    history = load_json(HISTORY_FILE, None)
    if not isinstance(history, dict):
        history = {}
    history.setdefault("version", 1)
    history.setdefault("source", None)
    history.setdefault("posts", [])
    history.setdefault("sinceIds", {})
    history.setdefault("updatedAt", None)
    return history


def classify_topic(text: str, account: dict) -> str:
    lower = text.lower()
    scores = {topic: 0 for topic in TOPIC_ORDER}
    for topic, words in TOPIC_KEYWORDS.items():
        for word in words:
            if word in lower:
                scores[topic] += 1
    best = max(scores, key=lambda key: scores[key])
    if scores[best] == 0:
        role = str(account.get("role", ""))
        return role if role in TOPIC_ORDER else "个股/事件驱动"
    return best


def extract_tickers(text: str, entities: dict | None = None) -> list[str]:
    found: list[str] = []
    entities = entities or {}
    for item in entities.get("cashtags") or []:
        if isinstance(item, dict):
            tag = str(item.get("tag", "")).strip().upper()
            if tag:
                found.append(tag)
    for match in re.finditer(r"\$([A-Za-z0-9.]{1,10})", text):
        tag = match.group(1).upper()
        if tag in KNOWN_TICKERS or (len(tag) <= 5 and tag not in STOP_TICKERS):
            found.append(tag)
    for ticker in KNOWN_TICKERS:
        if ticker in STOP_TICKERS:
            continue
        if re.search(r"\b" + re.escape(ticker) + r"\b", text):
            found.append(ticker)
    seen = set()
    result = []
    for ticker in found:
        if ticker not in seen:
            seen.add(ticker)
            result.append(ticker)
    return result[:8]


def score_sentiment(text: str) -> str:
    tokens = WORD_RE.findall(text.lower())
    bull = sum(1 for token in tokens if token in BULL_WORDS)
    bear = sum(1 for token in tokens if token in BEAR_WORDS)
    if bull > bear:
        return "看多"
    if bear > bull:
        return "看空"
    return "中性"


def score_importance(metrics: dict | None) -> str:
    metrics = metrics or {}
    try:
        score = (
            int(metrics.get("like_count", metrics.get("likes", 0)) or 0)
            + 2 * int(metrics.get("retweet_count", metrics.get("reposts", 0)) or 0)
            + int(metrics.get("reply_count", metrics.get("replies", 0)) or 0)
            + int(metrics.get("quote_count", metrics.get("quotes", 0)) or 0)
        )
    except (TypeError, ValueError):
        score = 0
    if score >= 500:
        return "高"
    if score >= 100:
        return "中"
    return "低"


def tweet_to_post(tweet: dict, handle: str, account: dict) -> dict | None:
    text = ""
    note = tweet.get("note_tweet")
    if isinstance(note, dict):
        text = str(note.get("text") or "")
    if not text:
        text = str(tweet.get("text") or "")
    text = text.strip()
    if not text:
        return None

    created = str(tweet.get("created_at") or "").replace("Z", "+00:00")
    try:
        created_at = datetime.fromisoformat(created).astimezone(TZ)
    except ValueError:
        created_at = NOW

    metrics = tweet.get("public_metrics") or {}
    tickers = extract_tickers(text, tweet.get("entities") or {})
    summary = text if len(text) <= 180 else text[:179].rstrip() + "…"
    tweet_id = str(tweet.get("id") or "").strip()
    if not tweet_id:
        return None

    return {
        "id": tweet_id,
        "account": handle,
        "date": created_at.strftime("%Y-%m-%d"),
        "time": created_at.strftime("%H:%M"),
        "topic": classify_topic(text, account),
        "sentiment": score_sentiment(text),
        "importance": score_importance(metrics),
        "tickers": tickers,
        "summary": summary,
        "text": text,
        "viewpoint": "",
        "note": "",
        "change": "",
        "url": f"https://x.com/{handle}/status/{tweet_id}",
        "watch": False,
        "lang": str(tweet.get("lang") or ""),
        "metrics": {
            "likes": int(metrics.get("like_count", 0) or 0),
            "reposts": int(metrics.get("retweet_count", 0) or 0),
            "replies": int(metrics.get("reply_count", 0) or 0),
            "quotes": int(metrics.get("quote_count", 0) or 0),
            "impressions": int(metrics.get("impression_count", 0) or 0),
        },
        "source": "x-api",
        "fetchedAt": NOW.isoformat(),
    }


def x_request(path: str, token: str, params: dict | None = None) -> dict:
    base = os.environ.get("X_API_BASE", "https://api.x.com/2").rstrip("/")
    url = base + path
    if params:
        url += "?" + urlencode(params)
    request = Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "User-Agent": "Signal8/1.0",
            "Accept": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=REQUEST_TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", "replace").strip()[:400]
        retry_after = exc.headers.get("Retry-After") if exc.headers else None
        raise XApiError(exc.code, body, retry_after) from exc
    except URLError as exc:
        raise RuntimeError(f"X API network error: {exc.reason}") from exc


def resolve_user(handle: str, token: str) -> str:
    data = x_request(
        f"/users/by/username/{quote(handle)}",
        token,
        {"user.fields": "id,name,username"},
    )
    user = data.get("data") or {}
    user_id = str(user.get("id") or "").strip()
    if not user_id:
        raise RuntimeError("user not found or not accessible")
    return user_id


def fetch_user_tweets(user_id: str, token: str, since_id: str | None) -> list[dict]:
    params = {
        "max_results": max_results(),
        "exclude": "retweets,replies",
        "tweet.fields": "created_at,public_metrics,entities,lang,note_tweet",
    }
    if since_id:
        params["since_id"] = since_id
    data = x_request(f"/users/{user_id}/tweets", token, params)
    tweets = data.get("data") or []
    return tweets if isinstance(tweets, list) else []


def sync_x(accounts: dict, history: dict, token: str) -> list[dict]:
    posts: list[dict] = []
    failures: list[tuple[str, str]] = []
    since_ids = history.setdefault("sinceIds", {})

    for handle, meta in accounts.items():
        try:
            user_id = resolve_user(handle, token)
            time.sleep(0.2)
            tweets = fetch_user_tweets(user_id, token, since_ids.get(handle))
            for tweet in tweets:
                post = tweet_to_post(tweet, handle, meta)
                if post:
                    posts.append(post)
            if tweets:
                ids = [str(item.get("id")) for item in tweets if item.get("id")]
                if ids:
                    since_ids[handle] = max(ids, key=lambda value: int(value) if value.isdigit() else 0)
            print(f"[sync] {handle}: {len(tweets)} tweets")
        except Exception as exc:  # noqa: BLE001 - per-account isolation is intentional
            failures.append((handle, str(exc)))
            print(f"[warn] {handle}: {exc}", file=sys.stderr)
        time.sleep(0.2)

    if failures and len(failures) == len(accounts):
        details = "; ".join(f"{handle}: {error}" for handle, error in failures)
        raise RuntimeError(f"all accounts failed: {details}")
    if failures:
        print(f"[warn] {len(failures)} account(s) failed; partial data kept", file=sys.stderr)
    return posts


def normalize_mock(item: dict, accounts: dict) -> dict | None:
    if not isinstance(item, dict):
        return None
    account = str(item.get("account") or "").strip()
    if account not in accounts:
        return None
    tweet_id = str(item.get("id") or "").strip()
    date = str(item.get("date") or "").strip()
    if not tweet_id or not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        return None
    time_value = str(item.get("time") or "00:00").strip()
    if not re.match(r"^\d{1,2}:\d{2}$", time_value):
        time_value = "00:00"
    hour, minute = time_value.split(":")
    time_value = f"{int(hour):02d}:{minute}"

    topic = str(item.get("topic") or "")
    if topic not in TOPIC_ORDER:
        topic = str(accounts[account].get("role") or "个股/事件驱动")
    sentiment = str(item.get("sentiment") or "中性")
    if sentiment not in ("看多", "看空", "中性"):
        sentiment = "中性"
    importance = str(item.get("importance") or "中")
    if importance not in ("高", "中", "低"):
        importance = "中"
    tickers = item.get("tickers") if isinstance(item.get("tickers"), list) else []
    summary = str(item.get("summary") or item.get("text") or "").strip()
    if not summary:
        return None
    url = str(item.get("url") or f"https://x.com/{account}")
    if not re.match(r"^https?://", url):
        url = f"https://x.com/{account}"

    return {
        "id": tweet_id,
        "account": account,
        "date": date,
        "time": time_value,
        "topic": topic,
        "sentiment": sentiment,
        "importance": importance,
        "tickers": [str(t).strip() for t in tickers if str(t).strip()][:8],
        "summary": summary,
        "viewpoint": str(item.get("viewpoint") or "").strip(),
        "note": str(item.get("note") or "").strip(),
        "change": str(item.get("change") or "").strip(),
        "url": url,
        "watch": item.get("watch") is True,
        "metrics": item.get("metrics") if isinstance(item.get("metrics"), dict) else {},
        "source": "mock",
        "fetchedAt": NOW.isoformat(),
    }


def mock_posts(accounts: dict) -> list[dict]:
    raw = load_json(MOCK_FILE, {})
    items = raw.get("posts") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        raise RuntimeError(f"mock fixture is invalid: {MOCK_FILE}")
    posts = []
    for item in items:
        post = normalize_mock(item, accounts)
        if post:
            posts.append(post)
    if not posts:
        raise RuntimeError("mock fixture contains no valid posts")
    return posts


def normalize_manual(item: dict, accounts: dict) -> dict | None:
    if not isinstance(item, dict):
        return None
    account = str(item.get("account") or "").strip()
    if account not in accounts:
        return None
    tweet_id = str(item.get("id") or "").strip()
    date = str(item.get("date") or "").strip()
    if not tweet_id or not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        return None
    time_value = str(item.get("time") or "00:00").strip()
    if not re.match(r"^\d{1,2}:\d{2}$", time_value):
        time_value = "00:00"
    hour, minute = time_value.split(":")
    time_value = f"{int(hour):02d}:{minute}"

    topic = str(item.get("topic") or "")
    if topic not in TOPIC_ORDER and topic != "其他":
        topic = str(accounts[account].get("role") or "个股/事件驱动")
    sentiment = str(item.get("sentiment") or "中性")
    if sentiment not in ("看多", "看空", "中性"):
        sentiment = "中性"
    importance = str(item.get("importance") or "中")
    if importance not in ("高", "中", "低"):
        importance = "中"
    tickers = item.get("tickers") if isinstance(item.get("tickers"), list) else []
    text = str(item.get("text") or "").strip()
    summary = str(item.get("summary") or text).strip()
    if not summary:
        return None
    url = str(item.get("url") or f"https://x.com/{account}")
    if not re.match(r"^https?://", url):
        url = f"https://x.com/{account}"

    return {
        "id": tweet_id,
        "account": account,
        "date": date,
        "time": time_value,
        "topic": topic,
        "sentiment": sentiment,
        "importance": importance,
        "tickers": [str(t).strip() for t in tickers if str(t).strip()][:8],
        "summary": summary,
        "text": text,
        "viewpoint": str(item.get("viewpoint") or "").strip(),
        "note": str(item.get("note") or "").strip(),
        "change": str(item.get("change") or "").strip(),
        "url": url,
        "watch": item.get("watch") is True,
        "metrics": item.get("metrics") if isinstance(item.get("metrics"), dict) else {},
        "lang": str(item.get("lang") or ""),
        "source": "manual",
        "fetchedAt": NOW.isoformat(),
    }


def manual_posts(accounts: dict) -> list[dict]:
    raw = load_json(MANUAL_FILE, {})
    items = raw.get("posts") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        raise RuntimeError(f"manual fixture is invalid: {MANUAL_FILE}")
    posts = []
    for item in items:
        post = normalize_manual(item, accounts)
        if post:
            posts.append(post)
    if not posts:
        raise RuntimeError("manual fixture contains no valid posts")
    return posts


def merge_posts(history: dict, new_posts: list[dict]) -> None:
    by_id = {str(post.get("id")): post for post in history.get("posts", []) if post.get("id")}
    for post in new_posts:
        post_id = str(post["id"])
        old = by_id.get(post_id)
        if not old:
            post["firstSeen"] = NOW.isoformat()
            post["lastSeen"] = NOW.isoformat()
            by_id[post_id] = post
            continue
        merged = dict(old)
        for key in ("metrics", "url", "source", "fetchedAt", "lang"):
            if post.get(key) is not None:
                merged[key] = post[key]
        for key in ("summary", "text", "viewpoint", "note", "change", "topic", "sentiment", "importance", "tickers", "watch"):
            if post.get(key) or merged.get(key) in (None, "", [], False):
                merged[key] = post[key]
        merged["lastSeen"] = NOW.isoformat()
        by_id[post_id] = merged
    history["posts"] = list(by_id.values())
    history["updatedAt"] = NOW.isoformat()


def prune_history(history: dict, source: str) -> None:
    if source in ("mock", "manual"):
        return
    cutoff = (NOW - timedelta(days=MAX_HISTORY_DAYS)).strftime("%Y-%m-%d")
    history["posts"] = [
        post for post in history.get("posts", [])
        if str(post.get("date", "")) >= cutoff
    ]


def build_output(accounts: dict, history: dict, source: str) -> None:
    if source in ("mock", "manual"):
        posts = history.get("posts", [])
    else:
        cutoff = (NOW - timedelta(days=MAX_OUTPUT_DAYS)).strftime("%Y-%m-%d")
        posts = [
            post for post in history.get("posts", [])
            if str(post.get("date", "")) >= cutoff
        ]
    posts = sorted(
        posts,
        key=lambda post: (str(post.get("date", "")), str(post.get("time", ""))),
        reverse=True,
    )
    payload = {
        "updatedAt": fmt_updated(NOW),
        "fetchedAt": NOW.isoformat(),
        "source": source,
        "accounts": accounts,
        "posts": posts,
    }
    header = (
        "/**\n"
        " * 自动生成文件：由 scripts/sync_x.py 写入。\n"
        " * 数据源：mock（fixture）或 x-api（X API v2）。\n"
        " * 请勿手工编辑；修改数据请改 data/fixtures 或重新同步。\n"
        " */\n"
    )
    OUTPUT_FILE.write_text(
        header + "window.DASHBOARD_DATA = " + json.dumps(payload, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )


def main() -> None:
    accounts = load_accounts()
    history = load_history()

    token = os.environ.get("X_BEARER_TOKEN", "").strip()
    force_mock = os.environ.get("MOCK_SYNC", "").strip() == "1"
    manual_available = MANUAL_FILE.exists()
    if token and not force_mock:
        source = "x-api"
    elif force_mock or not manual_available:
        source = "mock"
    else:
        source = "manual"

    print(f"[sync] mode={source} accounts={len(accounts)}")
    previous_source = history.get("source")
    if previous_source != source:
        if history.get("posts"):
            print(f"[sync] source changed {previous_source!r} -> {source!r}; resetting history")
        history["posts"] = []
        history["sinceIds"] = {}
    history["source"] = source

    if source == "mock":
        new_posts = mock_posts(accounts)
    elif source == "manual":
        new_posts = manual_posts(accounts)
    else:
        new_posts = sync_x(accounts, history, token)

    merge_posts(history, new_posts)
    prune_history(history, source)
    write_json_atomic(HISTORY_FILE, history)
    build_output(accounts, history, source)
    print(
        f"[sync] done source={source} new={len(new_posts)} "
        f"history={len(history['posts'])} output={OUTPUT_FILE}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - top-level CLI error
        print(f"[error] {exc}", file=sys.stderr)
        sys.exit(1)
