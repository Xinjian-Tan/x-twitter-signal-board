(function () {
  "use strict";

  const RAW = window.DASHBOARD_DATA || {};
  const SOURCE_LABELS = {
    "mock": "模拟自动更新 · 非实时",
    "x-api": "X API · 数据已同步",
    "manual": "真实推文 · 手动采样",
    "demo": "样本数据 · 非实时"
  };
  const source = String(RAW.source || "demo");
  const ORDER = ["半导体/供应链", "TMT/互联网", "市场/宏观", "个股/事件驱动"];
  const RANK = { "高": 3, "中": 2, "低": 1 };
  const LS_WATCH = "xab.watch.v1";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (m) => ESC_MAP[m]);
  }

  function normalizeSentiment(value) {
    const s = String(value || "").trim().toLowerCase();
    if (["看多", "多", "bull", "bullish", "long", "利好"].indexOf(s) !== -1) return "看多";
    if (["看空", "空", "bear", "bearish", "short", "利空"].indexOf(s) !== -1) return "看空";
    return "中性";
  }

  function normalizeImportance(value) {
    const s = String(value || "").trim().toLowerCase();
    if (["高", "high", "重要"].indexOf(s) !== -1) return "高";
    if (["低", "low"].indexOf(s) !== -1) return "低";
    return "中";
  }

  function normalizeTime(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
    if (!m) return "00:00";
    return String(m[1]).padStart(2, "0") + ":" + m[2];
  }

  function normalizeUrl(value) {
    const s = String(value || "").trim();
    if (!s) return "#";
    try {
      const u = new URL(s);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch (e) { /* ignore */ }
    return "#";
  }

  function normalizePosts(input) {
    if (!Array.isArray(input)) return [];
    const seen = new Set();
    const out = [];
    input.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const account = String(item.account || "").trim();
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || "")) ? String(item.date) : "";
      if (!account || !date) return;
      let id = String(item.id || "p" + (index + 1)).trim();
      while (seen.has(id)) id += "-" + index;
      seen.add(id);
      const tickers = Array.isArray(item.tickers)
        ? Array.from(new Set(item.tickers.map((t) => String(t || "").trim()).filter(Boolean)))
        : [];
      const summary = String(item.summary || item.text || "（暂无摘要）").trim() || "（暂无摘要）";
      out.push({
        id: id,
        account: account,
        date: date,
        time: normalizeTime(item.time),
        topic: ORDER.indexOf(item.topic) !== -1 ? item.topic : "其他",
        sentiment: normalizeSentiment(item.sentiment),
        importance: normalizeImportance(item.importance),
        tickers: tickers,
        summary: summary,
        text: String(item.text || "").trim(),
        viewpoint: String(item.viewpoint || "").trim(),
        note: String(item.note || "").trim(),
        change: String(item.change || "").trim(),
        url: normalizeUrl(item.url),
        watch: item.watch === true
      });
    });
    return out.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  }

  const rawAccounts = RAW.accounts && typeof RAW.accounts === "object" ? RAW.accounts : {};
  const posts = normalizePosts(RAW.posts);
  const accountKeys = Array.from(new Set(Object.keys(rawAccounts).concat(posts.map((p) => p.account))));
  const accounts = {};
  accountKeys.forEach((key) => {
    accounts[key] = Object.assign({ name: key, role: "" }, rawAccounts[key] || {});
  });

  const updatedAt = String(RAW.updatedAt || "未知");
  const dates = Array.from(new Set(posts.map((p) => p.date))).sort();
  const allTopics = ORDER.concat(
    Array.from(new Set(posts.map((p) => p.topic))).filter((t) => ORDER.indexOf(t) === -1)
  );

  const state = {
    view: "feed",
    account: "all",
    topic: "all",
    sentiment: "all",
    importance: "all",
    date: "all",
    search: "",
    trackedOnly: false,
    reportDate: dates.length ? dates[dates.length - 1] : null
  };

  function defaultWatch() {
    return new Set(posts.filter((p) => p.watch).map((p) => p.id));
  }

  function loadWatch() {
    try {
      const raw = localStorage.getItem(LS_WATCH);
      if (raw === null) return defaultWatch();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return defaultWatch();
      const validIds = new Set(posts.map((p) => p.id));
      const valid = arr.filter((x) => typeof x === "string" && validIds.has(x));
      // Old mock ids (p1…) do not exist after switching to real/manual data.
      if (arr.length > 0 && valid.length === 0) return defaultWatch();
      return new Set(valid);
    } catch (e) {
      return defaultWatch();
    }
  }

  let watch = loadWatch();
  let toastTimer = null;

  function toast(message) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  function saveWatch() {
    try {
      localStorage.setItem(LS_WATCH, JSON.stringify(Array.from(watch)));
    } catch (e) {
      toast("浏览器限制了本地存储，星标仅在本次会话有效");
    }
  }

  function sourceLabel() {
    return SOURCE_LABELS[source] || "数据源未知";
  }

  function applySourceBadge() {
    const badge = $("#sourceBadge");
    if (!badge) return;
    const label = sourceLabel();
    badge.textContent = label;
    badge.title = "当前数据源：" + label;
    badge.classList.toggle("live", source === "x-api");
    badge.classList.toggle("mock", source === "mock");
  }

  function toggleWatch(id) {
    if (!id) return;
    if (watch.has(id)) {
      watch.delete(id);
      toast("已取消跟踪");
    } else {
      watch.add(id);
      toast("已加入跟踪");
    }
    saveWatch();
    renderAll();
  }

  function sortPosts(a, b) {
    return (b.date + b.time).localeCompare(a.date + a.time);
  }

  function prevDateOf(date) {
    const i = dates.indexOf(date);
    return i > 0 ? dates[i - 1] : null;
  }

  function nextDateOf(date) {
    const i = dates.indexOf(date);
    return i >= 0 && i < dates.length - 1 ? dates[i + 1] : null;
  }

  function emptyCounts() {
    return { total: 0, bull: 0, bear: 0, neutral: 0 };
  }

  function addCount(counter, post) {
    counter.total += 1;
    if (post.sentiment === "看多") counter.bull += 1;
    else if (post.sentiment === "看空") counter.bear += 1;
    else counter.neutral += 1;
  }

  function statsFor(list) {
    const byTopic = {};
    allTopics.forEach((t) => { byTopic[t] = emptyCounts(); });
    const bySentiment = { "看多": 0, "看空": 0, "中性": 0 };
    const byAccount = {};
    const tickers = {};
    list.forEach((p) => {
      if (!byTopic[p.topic]) byTopic[p.topic] = emptyCounts();
      addCount(byTopic[p.topic], p);
      bySentiment[p.sentiment] = (bySentiment[p.sentiment] || 0) + 1;
      byAccount[p.account] = (byAccount[p.account] || 0) + 1;
      p.tickers.forEach((t) => {
        if (!tickers[t]) tickers[t] = emptyCounts();
        addCount(tickers[t], p);
      });
    });
    return { total: list.length, byTopic: byTopic, bySentiment: bySentiment, byAccount: byAccount, tickers: tickers };
  }

  function diffFor(date) {
    const prev = prevDateOf(date);
    const cur = statsFor(posts.filter((p) => p.date === date));
    const before = prev ? statsFor(posts.filter((p) => p.date === prev)) : null;
    const topicRows = allTopics.map((t) => {
      const c = cur.byTopic[t] || emptyCounts();
      const b = before ? (before.byTopic[t] || emptyCounts()) : null;
      return {
        name: t,
        cur: c,
        before: b,
        delta: b ? c.total - b.total : null,
        curNet: c.bull - c.bear,
        prevNet: b ? b.bull - b.bear : null
      };
    });
    return { date: date, prev: prev, cur: cur, before: before, topicRows: topicRows };
  }

  function tickerRowsFor(cur, before) {
    const map = {};
    Object.keys(cur.tickers).forEach((name) => {
      map[name] = { name: name, cur: cur.tickers[name], before: before && before.tickers[name] ? before.tickers[name] : null };
    });
    if (before) {
      Object.keys(before.tickers).forEach((name) => {
        if (!map[name]) map[name] = { name: name, cur: emptyCounts(), before: before.tickers[name] };
      });
    }
    return Object.keys(map).map((name) => {
      const row = map[name];
      return Object.assign({}, row, { delta: row.before ? row.cur.total - row.before.total : null });
    }).sort((a, b) => (b.cur.total - a.cur.total) || a.name.localeCompare(b.name));
  }

  function leanLabel(net) {
    if (net > 0) return "看多";
    if (net < 0) return "看空";
    return "中性";
  }

  function signed(n) {
    return n > 0 ? "+" + n : String(n);
  }

  function deltaClass(n) {
    if (n == null) return "delta-flat";
    return n > 0 ? "delta-up" : (n < 0 ? "delta-down" : "delta-flat");
  }

  function badgeClass(sentiment) {
    if (sentiment === "看多") return "bull";
    if (sentiment === "看空") return "bear";
    return "neutral";
  }

  function importanceClass(importance) {
    if (importance === "高") return "high";
    if (importance === "低") return "low";
    return "mid";
  }

  function avatarText(account) {
    return String(account || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  }

  function accountMeta(account) {
    return accounts[account] || { name: account, role: "" };
  }

  function filteredPosts() {
    const q = state.search.toLowerCase();
    return posts.filter((p) => {
      if (state.account !== "all" && p.account !== state.account) return false;
      if (state.topic !== "all" && p.topic !== state.topic) return false;
      if (state.sentiment !== "all" && p.sentiment !== state.sentiment) return false;
      if (state.importance !== "all" && p.importance !== state.importance) return false;
      if (state.date !== "all" && p.date !== state.date) return false;
      if (state.trackedOnly && !watch.has(p.id)) return false;
      if (q) {
        const hay = [p.account, p.topic, p.summary, p.viewpoint, p.note, p.tickers.join(" ")].join(" ").toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    }).sort(sortPosts);
  }

  function splitBar(counts) {
    if (!counts || !counts.total) return '<div class="split-bar" aria-hidden="true"></div>';
    const parts = [["bull", counts.bull], ["bear", counts.bear], ["neutral", counts.neutral]];
    return '<div class="split-bar" aria-hidden="true">' + parts.map((item) => {
      const key = item[0];
      const value = item[1];
      if (!value) return "";
      return '<i class="' + key + '" style="width:' + (value / counts.total * 100).toFixed(2) + '%"></i>';
    }).join("") + "</div>";
  }

  function renderTickerBars(rows) {
    if (!rows || !rows.length) return '<p class="muted small">暂无标的提及。</p>';
    const max = Math.max.apply(null, rows.map((r) => r.counts.total).concat([1]));
    return '<div class="ticker-chart">' + rows.map((row) => {
      const c = row.counts;
      const width = Math.max(4, c.total / max * 100);
      const segs = [["bull", c.bull], ["bear", c.bear], ["neutral", c.neutral]].map((item) => {
        const key = item[0];
        const value = item[1];
        if (!value) return "";
        return '<i class="' + key + '" style="width:' + (value / c.total * 100).toFixed(2) + '%"></i>';
      }).join("");
      return '<div class="ticker-row">' +
        '<span class="ticker-name">' + esc(row.name) + "</span>" +
        '<div class="ticker-track"><div class="ticker-stack" style="width:' + width.toFixed(2) + '%">' + segs + "</div></div>" +
        "<b>" + c.total + "</b>" +
        "</div>";
    }).join("") + "</div>";
  }

  function sourceLink(post) {
    if (post.url && post.url !== "#") {
      const isTweet = /\/status\/\d+/.test(post.url);
      return '<a class="source" href="' + esc(post.url) + '" target="_blank" rel="noopener noreferrer">' +
        (isTweet ? "查看原推文 ↗" : "查看原账号 ↗") + "</a>";
    }
    return '<span class="source-muted">Demo 未提供原文链接</span>';
  }

  function renderCard(post) {
    const meta = accountMeta(post.account);
    const watched = watch.has(post.id);
    return '<article class="card">' +
      '<div class="card-top">' +
        '<div class="account">' +
          '<div class="avatar" aria-hidden="true">' + esc(avatarText(post.account)) + "</div>" +
          "<div><strong>@" + esc(post.account) + "</strong><span>" + esc(meta.name) + (meta.role ? " · " + esc(meta.role) : "") + "</span></div>" +
        "</div>" +
        '<div class="card-side">' +
          '<button class="star ' + (watched ? "active" : "") + '" type="button" data-star="' + esc(post.id) + '" aria-pressed="' + (watched ? "true" : "false") + '" aria-label="' + (watched ? "取消跟踪" : "加入跟踪") + '">★</button>' +
          '<div class="date">' + esc(post.date) + "<br>" + esc(post.time) + "</div>" +
        "</div>" +
      "</div>" +
      '<div class="badges">' +
        '<span class="badge topic">' + esc(post.topic) + "</span>" +
        '<span class="badge ' + badgeClass(post.sentiment) + '">' + esc(post.sentiment) + "</span>" +
        '<span class="badge imp-' + importanceClass(post.importance) + '">重要性 ' + esc(post.importance) + "</span>" +
      "</div>" +
      '<p class="summary">' + esc(post.summary) + "</p>" +
      (post.text && post.text !== post.summary ? '<details class="original"><summary>原文</summary><p>' + esc(post.text) + "</p></details>" : "") +
      (post.viewpoint ? '<p class="viewpoint"><b>观点：</b>' + esc(post.viewpoint) + "</p>" : "") +
      (post.tickers.length ? '<div class="tickers">' + post.tickers.map((t) => "<span>" + esc(t) + "</span>").join("") + "</div>" : "") +
      (post.change ? '<p class="change">↻ ' + esc(post.change) + "</p>" : "") +
      (post.note ? '<p class="note"><b>分析师备注：</b>' + esc(post.note) + "</p>" : "") +
      sourceLink(post) +
      "</article>";
  }

  function renderCompareChips(date) {
    const diff = diffFor(date);
    if (!diff.before) return '<span class="compare-chip">首日 · 无上一日对比</span>';
    const tickerRows = tickerRowsFor(diff.cur, diff.before);
    const rising = diff.topicRows.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta)[0];
    const ticker = tickerRows.filter((r) => Math.abs(r.delta || 0) >= 1).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
    const chips = [];
    const totalDelta = diff.cur.total - diff.before.total;
    chips.push(compareChip("总条数", totalDelta));
    if (rising) chips.push(compareChip(rising.name + " 条", rising.delta));
    if (ticker) chips.push(compareChip(ticker.name + " 提及", ticker.delta));
    return chips.join("");
  }

  function compareChip(label, value) {
    const dir = value > 0 ? "up" : (value < 0 ? "down" : "flat");
    const arrow = value > 0 ? "▲" : (value < 0 ? "▼" : "—");
    return '<span class="compare-chip ' + dir + '">' + esc(label) + " " + arrow + " " + Math.abs(value) + "</span>";
  }

  function buildHighlights(diff, tickerRows) {
    const out = [];
    if (!diff.before) {
      out.push("今日 " + diff.cur.total + " 条；这是样本首日，暂无上一日对比。");
      return out;
    }
    const totalDelta = diff.cur.total - diff.before.total;
    out.push("今日 " + diff.cur.total + " 条，较上一日 " + signed(totalDelta) + " 条。");

    const rising = diff.topicRows.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta)[0];
    if (rising) out.push(rising.name + " 讨论升温，较上一日 " + signed(rising.delta) + " 条。");

    let shift = null;
    diff.topicRows.forEach((row) => {
      if (!row.before || row.cur.total < 2 || row.before.total < 2) return;
      const change = row.curNet - row.prevNet;
      if (leanLabel(row.curNet) !== leanLabel(row.prevNet) || Math.abs(change) >= 2) {
        if (!shift || Math.abs(change) > Math.abs(shift.change)) shift = { row: row, change: change };
      }
    });
    if (shift) {
      out.push(shift.row.name + " 情绪由" + leanLabel(shift.row.prevNet) + "转向" + leanLabel(shift.row.curNet) + "。");
    }

    const ticker = tickerRows.filter((r) => r.before && Math.abs(r.delta) >= 1)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
    if (ticker) out.push(ticker.name + " 提及量较上一日 " + signed(ticker.delta) + " 次。");

    return out.slice(0, 4);
  }

  function buildReport(date) {
    const list = posts.filter((p) => p.date === date);
    const diff = diffFor(date);
    const tickerRows = tickerRowsFor(diff.cur, diff.before);
    const topPosts = list.slice().sort((a, b) => (RANK[b.importance] - RANK[a.importance]) || b.time.localeCompare(a.time));
    const watchPosts = list.filter((p) => watch.has(p.id));
    const suggested = watchPosts.length ? [] : topPosts.filter((p) => p.importance === "高").slice(0, 3);
    return {
      date: date,
      prev: diff.prev,
      posts: list,
      cur: diff.cur,
      before: diff.before,
      topicRows: diff.topicRows.filter((r) => r.cur.total > 0 || (r.before && r.before.total > 0)),
      tickerRows: tickerRows,
      topTickers: tickerRows.filter((r) => r.cur.total > 0).slice(0, 8),
      topPosts: topPosts.slice(0, 5),
      watchPosts: watchPosts,
      suggested: suggested,
      highlights: buildHighlights(diff, tickerRows),
      manualChanges: list.filter((p) => p.change)
    };
  }

  function renderStats() {
    const list = filteredPosts();
    const high = list.filter((p) => p.importance === "高").length;
    const tickerSet = new Set();
    list.forEach((p) => p.tickers.forEach((t) => tickerSet.add(t)));
    const accountSet = new Set(list.map((p) => p.account));
    const deltaText = state.date !== "all" ? "所选日期 · " + state.date : "当前筛选 · " + dates.length + " 个日期";
    $("#stats").innerHTML =
      '<div class="stat"><span>当前信息</span><strong>' + list.length + "</strong><em>" + esc(deltaText) + "</em></div>" +
      '<div class="stat"><span>高重要性</span><strong>' + high + "</strong><em>需优先阅读</em></div>" +
      '<div class="stat"><span>涉及标的</span><strong>' + tickerSet.size + "</strong><em>去重后</em></div>" +
      '<div class="stat"><span>覆盖账号</span><strong>' + accountSet.size + "</strong><em>/ " + accountKeys.length + " 个监控源</em></div>";
  }

  function renderFeed() {
    const list = filteredPosts();
    const ctxDate = state.date !== "all" ? state.date : dates[dates.length - 1];
    const compareLabel = state.date === "all" ? "最新日 vs 上一日 · 全量样本" : "所选日期 vs 上一日 · 全量样本";
    $("#feedView").innerHTML =
      '<div class="section-head">' +
        '<div><p class="eyebrow">LIVE FEED · SIGNAL SNAPSHOT</p><h2>信息流</h2></div>' +
        "<span>" + list.length + " 条</span>" +
      "</div>" +
      '<div class="compare-row"><span class="compare-label">' + esc(compareLabel) + "</span>" + (ctxDate ? renderCompareChips(ctxDate) : "") + "</div>" +
      (list.length
        ? '<div class="grid">' + list.map(renderCard).join("") + "</div>"
        : '<div class="empty">当前筛选条件下没有信息。试试重置筛选或取消「仅看跟踪」。</div>');
  }

  function renderTrend() {
    const trendTopics = allTopics.filter((t) => posts.some((p) => p.topic === t));
    if (!trendTopics.length) return '<p class="muted small">暂无趋势数据。</p>';
    const blocks = trendTopics.map((topic) => {
      const daily = dates.map((date) => {
        const stats = statsFor(posts.filter((p) => p.date === date && p.topic === topic));
        return { date: date, total: stats.total, bull: stats.bySentiment["看多"], bear: stats.bySentiment["看空"], neutral: stats.bySentiment["中性"] };
      });
      const max = Math.max.apply(null, daily.map((d) => d.total).concat([1]));
      const cols = daily.map((d) => {
        if (!d.total) return '<div class="trend-col" title="' + esc(d.date) + ' · 0 条"><div class="trend-empty"></div></div>';
        const height = Math.max(6, d.total / max * 100);
        const segs = [["bull", d.bull], ["bear", d.bear], ["neutral", d.neutral]].map((item) => {
          const key = item[0];
          const value = item[1];
          if (!value) return "";
          return '<i class="' + key + '" style="height:' + (value / d.total * 100).toFixed(2) + '%"></i>';
        }).join("");
        return '<div class="trend-col" title="' + esc(d.date) + " · 多 " + d.bull + " / 空 " + d.bear + " / 中性 " + d.neutral + '"><div class="trend-stack" style="height:' + height.toFixed(2) + '%">' + segs + "</div></div>";
      }).join("");
      const total = daily.reduce((sum, d) => sum + d.total, 0);
      return '<div class="trend-block">' +
        '<div class="trend-head"><strong>' + esc(topic) + "</strong><span>" + total + " 条 / " + dates.length + " 个日期</span></div>" +
        '<div class="trend-cols">' + cols + "</div>" +
        '<div class="trend-days">' + dates.map((d) => "<span>" + esc(d.slice(5)) + "</span>").join("") + "</div>" +
        "</div>";
    }).join("");
    return '<div class="legend"><span><i class="legend-dot bull"></i>看多</span><span><i class="legend-dot bear"></i>看空</span><span><i class="legend-dot neutral"></i>中性</span></div>' +
      '<div class="trend-grid">' + blocks + "</div>";
  }

  function renderTopics() {
    const list = filteredPosts();
    if (!list.length) {
      $("#topicsView").innerHTML = '<div class="section-head"><div><p class="eyebrow">TOPIC AGGREGATION</p><h2>主题聚合</h2></div><span>0 条</span></div><div class="empty">当前筛选条件下没有主题信息。试试重置筛选。</div>';
      return;
    }
    const stats = statsFor(list);
    const topicCards = allTopics.map((topic) => {
      const counts = stats.byTopic[topic] || emptyCounts();
      if (!counts.total) return "";
      const items = list.filter((p) => p.topic === topic).sort(sortPosts);
      const latest = items[0];
      const accountCount = {};
      items.forEach((p) => { accountCount[p.account] = (accountCount[p.account] || 0) + 1; });
      const topAccounts = Object.keys(accountCount).sort((a, b) => accountCount[b] - accountCount[a]).slice(0, 2);
      return '<article class="topic-card">' +
        '<div class="topic-card-head"><h3>' + esc(topic) + "</h3><span>" + counts.total + " 条</span></div>" +
        splitBar(counts) +
        '<p class="muted small">多 ' + counts.bull + " · 空 " + counts.bear + " · 中性 " + counts.neutral + "</p>" +
        '<p class="top-accounts">活跃：' + topAccounts.map((a) => "@" + esc(a)).join(" ") + "</p>" +
        '<p class="topic-latest">' + esc(latest ? latest.summary : "—") + "</p>" +
        "</article>";
    }).join("");

    const tickerRows = Object.keys(stats.tickers).map((name) => ({ name: name, counts: stats.tickers[name] }))
      .sort((a, b) => b.counts.total - a.counts.total).slice(0, 12);

    const groups = allTopics.map((topic) => ({ topic: topic, items: list.filter((p) => p.topic === topic) }))
      .filter((g) => g.items.length);

    $("#topicsView").innerHTML =
      '<div class="section-head"><div><p class="eyebrow">TOPIC AGGREGATION</p><h2>主题聚合</h2></div><span>' + list.length + " 条 · " + dates.length + " 个日期</span></div>" +
      '<div class="topic-grid">' + topicCards + "</div>" +
      '<section class="panel wide" style="margin-bottom:16px">' +
        "<h3>标的提及 Top 12</h3>" +
        '<p class="muted small">按当前筛选统计，颜色区分多/空/中性。</p>' +
        renderTickerBars(tickerRows) +
      "</section>" +
      '<section class="panel wide" style="margin-bottom:16px">' +
        "<h3>样本日期情绪趋势</h3>" +
        '<p class="muted small">全量样本、' + dates.length + ' 个有数据日期，不随筛选变化。</p>' +
        renderTrend() +
      "</section>" +
      groups.map((g) =>
        '<section class="topic-group">' +
          '<div class="section-head small"><h3>' + esc(g.topic) + "</h3><span>" + g.items.length + " 条</span></div>" +
          '<div class="grid">' + g.items.map(renderCard).join("") + "</div>" +
        "</section>"
      ).join("");
  }

  function reportPost(post) {
    const watched = watch.has(post.id);
    return '<article class="report-post">' +
      '<div class="report-post-top">' +
        '<span class="badge ' + badgeClass(post.sentiment) + '">' + esc(post.sentiment) + "</span>" +
        '<span class="report-post-meta">@' + esc(post.account) + " · " + esc(post.time) + " · 重要性 " + esc(post.importance) + "</span>" +
        '<button class="star ' + (watched ? "active" : "") + '" type="button" data-star="' + esc(post.id) + '" aria-pressed="' + (watched ? "true" : "false") + '" aria-label="' + (watched ? "取消跟踪" : "加入跟踪") + '">★</button>' +
      "</div>" +
      '<p class="summary">' + esc(post.summary) + "</p>" +
      (post.text && post.text !== post.summary ? '<details class="original"><summary>原文</summary><p>' + esc(post.text) + "</p></details>" : "") +
      (post.viewpoint ? '<p class="viewpoint">' + esc(post.viewpoint) + "</p>" : "") +
      (post.tickers.length ? '<div class="tickers">' + post.tickers.map((t) => "<span>" + esc(t) + "</span>").join("") + "</div>" : "") +
      (post.change ? '<p class="change">↻ ' + esc(post.change) + "</p>" : "") +
      sourceLink(post) +
      "</article>";
  }

  function corePanel(report) {
    const top = report.topPosts.slice(0, 3);
    return '<section class="panel wide">' +
      "<h3>今日核心观点</h3>" +
      (top.length
        ? '<ol class="insight-list">' + top.map((p) =>
            "<li><span class=\"badge " + badgeClass(p.sentiment) + '">' + esc(p.sentiment) + "</span>" +
            "<b>@" + esc(p.account) + "</b> " + esc(p.summary) +
            " <em>" + esc(p.tickers.join(" / ")) + "</em></li>"
          ).join("") + "</ol>"
        : '<p class="muted">暂无信息。</p>') +
      (report.highlights.length ? '<ul class="highlight-list">' + report.highlights.map((h) => "<li>" + esc(h) + "</li>").join("") + "</ul>" : "") +
      "</section>";
  }

  function renderTickerTable(rows) {
    if (!rows.length) return '<p class="muted small">今日无标的提及。</p>';
    return '<div class="table-wrap"><table class="report-table">' +
      "<thead><tr><th>标的</th><th>今日</th><th>上一日</th><th>变化</th><th>多</th><th>空</th><th>中性</th></tr></thead>" +
      "<tbody>" + rows.map((r) =>
        "<tr>" +
          "<td>" + esc(r.name) + "</td>" +
          "<td>" + r.cur.total + "</td>" +
          "<td>" + (r.before ? r.before.total : "—") + "</td>" +
          '<td class="' + deltaClass(r.delta) + '">' + (r.delta == null ? "—" : signed(r.delta)) + "</td>" +
          "<td>" + r.cur.bull + "</td>" +
          "<td>" + r.cur.bear + "</td>" +
          "<td>" + r.cur.neutral + "</td>" +
        "</tr>"
      ).join("") + "</tbody></table></div>";
  }

  function tickerPanel(report) {
    return '<section class="panel wide">' +
      "<h3>高频标的</h3>" +
      '<p class="muted small">今日提及 Top ' + report.topTickers.length + "，并对比上一日。</p>" +
      renderTickerBars(report.topTickers.map((r) => ({ name: r.name, counts: r.cur }))) +
      renderTickerTable(report.topTickers) +
      "</section>";
  }

  function sentimentPanel(report) {
    const rows = report.topicRows;
    return '<section class="panel">' +
      "<h3>情绪变化</h3>" +
      '<p class="muted small">今日 vs ' + (report.prev ? esc(report.prev) : "无上一日") + "</p>" +
      (rows.length
        ? '<div class="table-wrap"><table class="report-table">' +
            "<thead><tr><th>主题</th><th>今日 多/空/中性</th><th>上一日</th><th>净倾向</th></tr></thead>" +
            "<tbody>" + rows.map((r) => {
              const changed = r.before && (leanLabel(r.curNet) !== leanLabel(r.prevNet) || Math.abs(r.curNet - r.prevNet) >= 2);
              const cls = changed ? (r.curNet > r.prevNet ? "delta-up" : "delta-down") : "";
              return "<tr>" +
                "<td>" + esc(r.name) + "</td>" +
                "<td>" + r.cur.bull + "/" + r.cur.bear + "/" + r.cur.neutral + "</td>" +
                "<td>" + (r.before ? r.before.bull + "/" + r.before.bear + "/" + r.before.neutral : "—") + "</td>" +
                '<td class="' + cls + '">' + esc(leanLabel(r.curNet)) + (r.before ? "（" + esc(leanLabel(r.prevNet)) + " → " + esc(leanLabel(r.curNet)) + "）" : "") + "</td>" +
                "</tr>";
            }).join("") + "</tbody></table></div>"
        : '<p class="muted small">暂无主题数据。</p>') +
      "</section>";
  }

  function changesPanel(report) {
    return '<section class="panel">' +
      "<h3>重要变化</h3>" +
      (report.highlights.length
        ? '<ul class="highlight-list">' + report.highlights.map((h) => "<li>" + esc(h) + "</li>").join("") + "</ul>"
        : '<p class="muted small">暂无自动变化摘要。</p>') +
      (report.manualChanges.length
        ? "<h4>分析师手写变化</h4><ul class=\"change-list\">" + report.manualChanges.map((p) => "<li><b>@" + esc(p.account) + "</b> " + esc(p.change) + "</li>").join("") + "</ul>"
        : "") +
      "</section>";
  }

  function topPanel(report) {
    return '<section class="panel wide">' +
      "<h3>今日 Top 5</h3>" +
      (report.topPosts.length ? '<div class="report-posts">' + report.topPosts.map(reportPost).join("") + "</div>" : '<p class="muted small">暂无信息。</p>') +
      "</section>";
  }

  function watchPanel(report) {
    const list = report.watchPosts;
    const hint = list.length
      ? "已星标信息。点击星标可移出跟踪。"
      : "暂无星标；在信息流点星标加入跟踪。";
    const suggestion = !list.length && report.suggested.length
      ? " 可优先关注：" + report.suggested.map((p) => "@" + p.account).join("、") + "。"
      : "";
    return '<section class="panel wide">' +
      "<h3>待跟踪</h3>" +
      '<p class="muted small">' + hint + suggestion + "</p>" +
      (list.length
        ? '<div class="watch-list">' + list.map((p) =>
            '<div class="watch-row">' +
              '<span class="badge ' + badgeClass(p.sentiment) + '">' + esc(p.sentiment) + "</span>" +
              '<span class="watch-text"><b>@' + esc(p.account) + "</b> · " + esc(p.summary) + "</span>" +
              '<button class="star active" type="button" data-star="' + esc(p.id) + '" aria-pressed="true" aria-label="取消跟踪">★</button>' +
            "</div>"
          ).join("") + "</div>"
        : "") +
      "</section>";
  }

  function renderDaily() {
    if (!dates.length) {
      $("#dailyView").innerHTML = '<div class="empty">暂无日报数据。</div>';
      return;
    }
    if (!state.reportDate || dates.indexOf(state.reportDate) === -1) {
      state.reportDate = dates[dates.length - 1];
    }
    const report = buildReport(state.reportDate);
    const prev = prevDateOf(state.reportDate);
    const next = nextDateOf(state.reportDate);
    const options = dates.slice().reverse().map((d) =>
      '<option value="' + esc(d) + '"' + (d === state.reportDate ? " selected" : "") + ">" + esc(d) + "</option>"
    ).join("");
    $("#dailyView").innerHTML =
      '<div class="report-head">' +
        "<div>" +
          '<p class="eyebrow">DAILY BRIEF · FUND ANALYST VIEW</p>' +
          "<h2>" + esc(state.reportDate) + " 分析师日报</h2>" +
          '<p class="muted">' + report.posts.length + " 条信息 · " + accountKeys.length + " 个账号 · " + report.topicRows.length + " 个主题 · 数据源：" + esc(sourceLabel()) + "</p>" +
        "</div>" +
        '<div class="report-actions">' +
          '<button class="ghost" type="button" data-export>下载 Markdown</button>' +
          '<button class="ghost" type="button" data-print>打印 / PDF</button>' +
        "</div>" +
      "</div>" +
      '<div class="report-nav">' +
        '<button class="ghost" type="button" data-report-prev ' + (prev ? "" : "disabled") + ">← 上一日" + (prev ? " · " + esc(prev) : "") + "</button>" +
        '<label class="sr-only" for="reportDateSelect">选择日报日期</label>' +
        '<select id="reportDateSelect">' + options + "</select>" +
        '<button class="ghost" type="button" data-report-next ' + (next ? "" : "disabled") + ">" + (next ? esc(next) + " · 下一日" : "下一日") + " →</button>" +
      "</div>" +
      '<div class="report-grid">' +
        corePanel(report) +
        tickerPanel(report) +
        sentimentPanel(report) +
        changesPanel(report) +
        topPanel(report) +
        watchPanel(report) +
      "</div>" +
      '<p class="source-note">' + esc(sourceLabel()) + " · 最后更新 " + esc(updatedAt) + "。日报由前端按日期自动聚合，不构成投资建议。</p>";
  }

  function mdCell(value) {
    return String(value == null ? "" : value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  }

  function buildMarkdown(report) {
    const lines = [];
    lines.push("# TMT 信号日报 · " + report.date, "");
    lines.push("> 数据来源：样本数据（Demo，非实时）");
    lines.push("> 覆盖：" + report.posts.length + " 条 · " + new Set(report.posts.map((p) => p.account)).size + " 个账号 · " + report.topicRows.length + " 个主题");
    lines.push("> 生成时间：" + updatedAt, "");
    lines.push("## 一、今日核心观点", "");
    report.topPosts.slice(0, 3).forEach((p, i) => {
      lines.push((i + 1) + ". **@" + p.account + "**（" + p.sentiment + "）：" + mdCell(p.summary));
    });
    lines.push("");
    lines.push("自动变化摘要：");
    report.highlights.forEach((h) => lines.push("- " + mdCell(h)));
    lines.push("");
    lines.push("## 二、高频标的", "");
    lines.push("| 标的 | 今日 | 上一日 | 变化 | 多 | 空 | 中性 |");
    lines.push("|---|---:|---:|---:|---:|---:|---:|");
    report.topTickers.forEach((r) => {
      lines.push("| " + mdCell(r.name) + " | " + r.cur.total + " | " + (r.before ? r.before.total : "—") + " | " + (r.delta == null ? "—" : signed(r.delta)) + " | " + r.cur.bull + " | " + r.cur.bear + " | " + r.cur.neutral + " |");
    });
    lines.push("");
    lines.push("## 三、情绪变化", "");
    lines.push("| 主题 | 今日 多/空/中性 | 上一日 多/空/中性 | 净倾向 |");
    lines.push("|---|---|---|---|");
    report.topicRows.forEach((r) => {
      lines.push("| " + mdCell(r.name) + " | " + r.cur.bull + "/" + r.cur.bear + "/" + r.cur.neutral + " | " + (r.before ? r.before.bull + "/" + r.before.bear + "/" + r.before.neutral : "—") + " | " + leanLabel(r.curNet) + " |");
    });
    lines.push("");
    lines.push("## 四、重要变化", "");
    report.highlights.forEach((h) => lines.push("- " + mdCell(h)));
    report.manualChanges.forEach((p) => lines.push("- **@" + p.account + "** " + mdCell(p.change)));
    lines.push("");
    lines.push("## 五、今日 Top 5", "");
    report.topPosts.forEach((p, i) => {
      lines.push("### " + (i + 1) + ". @" + p.account + " · " + p.time + " · 重要性" + p.importance, "");
      lines.push(mdCell(p.summary), "");
      if (p.viewpoint) lines.push("> 观点：" + mdCell(p.viewpoint), "");
      if (p.tickers.length) lines.push("标的：" + p.tickers.join(" / "), "");
      if (p.url !== "#") {
        const label = /\/status\/\d+/.test(p.url) ? "查看原推文" : "查看原账号";
        lines.push("[" + label + "](" + p.url + ")", "");
      }
    });
    lines.push("## 六、待跟踪", "");
    if (!report.watchPosts.length) {
      lines.push("暂无跟踪项。");
      if (report.suggested.length) {
        lines.push("可优先关注：" + report.suggested.map((p) => "@" + p.account).join("、") + "。");
      }
    } else {
      report.watchPosts.forEach((p) => lines.push("- **@" + p.account + "** · " + p.time + "：" + mdCell(p.summary)));
    }
    lines.push("");
    lines.push("## 七、数据说明与免责声明", "");
    lines.push("本日报由 Demo 页面前端自动聚合，数据为合成样本，非实时，不构成任何投资建议。");
    lines.push("");
    return lines.join("\n");
  }

  function downloadMarkdown() {
    try {
      const report = buildReport(state.reportDate);
      const md = buildMarkdown(report);
      const blob = new Blob(["\ufeff", md], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "x-analyst-daily-" + state.reportDate + ".md";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("Markdown 已开始下载");
    } catch (e) {
      toast("导出失败，请重试");
    }
  }

  function printReport() {
    state.view = "daily";
    renderAll();
    setTimeout(() => window.print(), 100);
  }

  function syncTabs() {
    const map = { feed: "#feedView", topics: "#topicsView", daily: "#dailyView" };
    Object.keys(map).forEach((view) => {
      const el = $(map[view]);
      if (el) el.classList.toggle("hidden", view !== state.view);
    });
    document.body.classList.toggle("view-daily", state.view === "daily");
    $$(".tab").forEach((btn) => {
      const active = btn.getAttribute("data-view") === state.view;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function updateTrackedButton() {
    const btn = $("#trackedBtn");
    if (!btn) return;
    btn.classList.toggle("active", state.trackedOnly);
    btn.setAttribute("aria-pressed", state.trackedOnly ? "true" : "false");
    const count = $("#trackedCount");
    if (count) count.textContent = String(watch.size);
  }

  function renderAll() {
    if (!posts.length) {
      $("#stats").innerHTML = "";
      $("#feedView").innerHTML = '<div class="empty">没有可用数据，请检查 data.js。</div>';
      $("#topicsView").innerHTML = '<div class="empty">没有可用数据。</div>';
      $("#dailyView").innerHTML = '<div class="empty">没有可用数据。</div>';
      return;
    }
    renderStats();
    renderFeed();
    renderTopics();
    renderDaily();
    updateTrackedButton();
    syncTabs();
  }

  function initSelects() {
    const updated = $("#updatedAt");
    if (updated) updated.textContent = updatedAt;

    $("#accountFilter").innerHTML = '<option value="all">全部账号</option>' +
      accountKeys.map((key) => '<option value="' + esc(key) + '">@' + esc(key) + "</option>").join("");
    $("#topicFilter").innerHTML = '<option value="all">全部主题</option>' +
      allTopics.map((topic) => '<option value="' + esc(topic) + '">' + esc(topic) + "</option>").join("");
    $("#sentimentFilter").innerHTML = '<option value="all">全部情绪</option>' +
      ["看多", "看空", "中性"].map((s) => '<option value="' + esc(s) + '">' + esc(s) + "</option>").join("");
    $("#importanceFilter").innerHTML = '<option value="all">全部重要性</option>' +
      ["高", "中", "低"].map((s) => '<option value="' + esc(s) + '">' + esc(s) + "</option>").join("");
    $("#dateFilter").innerHTML = '<option value="all">全部日期</option>' +
      dates.slice().reverse().map((d) => '<option value="' + esc(d) + '">' + esc(d) + "</option>").join("");
  }

  function bind() {
    $("#accountFilter").addEventListener("change", (e) => { state.account = e.target.value; renderAll(); });
    $("#topicFilter").addEventListener("change", (e) => { state.topic = e.target.value; renderAll(); });
    $("#sentimentFilter").addEventListener("change", (e) => { state.sentiment = e.target.value; renderAll(); });
    $("#importanceFilter").addEventListener("change", (e) => { state.importance = e.target.value; renderAll(); });
    $("#dateFilter").addEventListener("change", (e) => { state.date = e.target.value; renderAll(); });

    let searchTimer = null;
    $("#searchInput").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      const value = e.target.value;
      searchTimer = setTimeout(() => { state.search = value.trim(); renderAll(); }, 120);
    });

    $("#trackedBtn").addEventListener("click", () => {
      state.trackedOnly = !state.trackedOnly;
      renderAll();
    });

    $("#resetBtn").addEventListener("click", () => {
      state.account = "all";
      state.topic = "all";
      state.sentiment = "all";
      state.importance = "all";
      state.date = "all";
      state.search = "";
      state.trackedOnly = false;
      $("#accountFilter").value = "all";
      $("#topicFilter").value = "all";
      $("#sentimentFilter").value = "all";
      $("#importanceFilter").value = "all";
      $("#dateFilter").value = "all";
      $("#searchInput").value = "";
      renderAll();
    });

    $$(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.view = btn.getAttribute("data-view");
        syncTabs();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });

    document.addEventListener("click", (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;

      const star = target.closest("[data-star]");
      if (star) {
        e.preventDefault();
        toggleWatch(star.getAttribute("data-star"));
        return;
      }

      const prev = target.closest("[data-report-prev]");
      if (prev) {
        const i = dates.indexOf(state.reportDate);
        if (i > 0) {
          state.reportDate = dates[i - 1];
          renderAll();
        }
        return;
      }

      const next = target.closest("[data-report-next]");
      if (next) {
        const i = dates.indexOf(state.reportDate);
        if (i >= 0 && i < dates.length - 1) {
          state.reportDate = dates[i + 1];
          renderAll();
        }
        return;
      }

      if (target.closest("[data-export]")) {
        downloadMarkdown();
        return;
      }

      if (target.closest("[data-print]")) {
        printReport();
      }
    });

    document.addEventListener("change", (e) => {
      if (e.target && e.target.id === "reportDateSelect") {
        state.reportDate = e.target.value;
        renderAll();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "/") return;
      const tag = document.activeElement ? document.activeElement.tagName : "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      $("#searchInput").focus();
    });
  }

  function init() {
    applySourceBadge();
    if (!posts.length) {
      renderAll();
      return;
    }
    initSelects();
    bind();
    renderAll();
  }

  init();
})();
