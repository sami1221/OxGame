/* ============================================================
   FRONTEND INTEGRATION — replaces the localStorage-based logic
   in your original <script> block with real backend calls.

   What changes vs. the original file:
   - All balances/ads/withdrawals come from the backend (Postgres),
     not localStorage — so they're real, shared, and survive reinstalls.
   - Leaderboard is now REAL data (actual users), not generated mock rows.
   - Ad rewards for AdsGram-shown ads are credited by AdsGram's own
     server-to-server postback hitting your backend directly — the
     client only refreshes the displayed balance afterwards. This means
     a modified/hacked client cannot grant itself rewards.
   - The Telegram "join channel" task is verified for real via the
     Telegram Bot API. TikTok stays honor-system (no public API exists).
   - Currency is TON, not USD — see INTEGRATION.md for the markup changes
     this requires (the "$" symbols in your HTML should become "TON").
   - Admin panel visibility/actions are now enforced server-side.
   ============================================================ */

// ---- CONFIG ----
const API_BASE = 'https://humble-space-potato-96765rwxr97x37p6g-3000.app.github.dev/api'; // 🔧 set this

// ════════ TELEGRAM INIT ════════
const tg = window.Telegram?.WebApp;
let tgUsername = 'Demo User';
let tgUserId = null;
if (tg) {
  tg.ready();
  tg.expand();
  const user = tg.initDataUnsafe?.user;
  tgUsername = user?.first_name || 'User';
  tgUserId = user?.id || null;
}
document.getElementById('username').textContent = tgUsername;

// ════════ API CLIENT ════════
async function api(path, opts = {}) {
  const initData = tg?.initData || '';
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'tma ' + initData,
      ...(opts.headers || {}),
    },
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body, fine */ }
  if (!res.ok && !data.error) data.error = 'request_failed';
  return data;
}

function nanotonToTon(nanoton, decimals = 4) {
  return (Number(nanoton || 0) / 1e9).toFixed(decimals);
}

// ════════ ADSGRAM ════════
const ADSGRAM_BLOCK_ID = '35767';
let AdController = null;
try {
  if (window.Adsgram) AdController = window.Adsgram.init({ blockId: ADSGRAM_BLOCK_ID });
} catch (e) { console.warn('AdsGram init failed', e); }

// ════════ LOCAL UI STATE (not authoritative — just cached for rendering) ════════
let cache = { status: null, wallet: null, tasks: null };
let isWatching = false;
let lbPeriod = 'daily';

// ════════ PAGE SWITCHING ════════
function switchPage(name) {
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === name));
  if (name === 'leaderboard') renderLeaderboard();
  if (name === 'wallet') renderWallet();
  if (name === 'task') renderTasks();
}

// ════════ HOME ════════
async function updateUI() {
  const status = await api('/ads/status');
  if (status.error) { showToast('⚠️ ' + status.error); return; }
  cache.status = status;

  document.getElementById('totalBalance').textContent = nanotonToTon(status.balanceNanoton, 3);
  document.getElementById('adsWatched').textContent = status.adsWatchedTotal;
  document.getElementById('todayEarned').textContent = ''; // optional: track separately if you want this back

  document.getElementById('adsCount').textContent = Math.min(status.adsToday, status.dailyLimit);
  document.getElementById('dailyLimitLabel').textContent = status.dailyLimit;
  document.getElementById('dailyLimitLabel2').textContent = status.dailyLimit;
  document.getElementById('dailyBonusLabel').textContent = '+' + nanotonToTon(status.dailyBonusNanoton, 2) + ' TON bonus';

  const pct = Math.min((status.adsToday / status.dailyLimit) * 100, 100);
  setTimeout(() => { document.getElementById('progFill').style.width = pct + '%'; }, 200);

  const btn = document.getElementById('watchBtn');
  if (status.adsToday >= status.dailyLimit && !isWatching) {
    btn.disabled = true;
    btn.innerHTML = '<span>🔒</span><span>Daily Limit Reached</span>';
  } else if (!isWatching) {
    btn.disabled = false;
    btn.innerHTML = `<span>▶</span><span>Watch Ad & Earn</span><span class="earn-badge">+${nanotonToTon(status.perAdNanoton, 3)} TON</span>`;
  }
}

// ════════ WATCH AD ════════
async function watchAd() {
  if (isWatching) return;
  const status = cache.status || (await api('/ads/status'));
  if (status.adsToday >= status.dailyLimit) { showToast('🔒 Daily limit reached!'); return; }

  isWatching = true;
  const btn = document.getElementById('watchBtn');
  btn.innerHTML = '<div class="spinner"></div><span>Loading Ad...</span>';
  btn.disabled = true;

  if (AdController) {
    try {
      await AdController.show(); // resolves only if watched to completion
      // Reward is credited server-side by AdsGram's Reward URL postback,
      // NOT by this client call. Give it a moment to arrive, then refresh.
      showToast('✅ Ad watched! Crediting reward…');
      await new Promise((r) => setTimeout(r, 4000));
    } catch {
      showToast('⚠️ Ad skipped — no reward');
    }
  } else {
    await showAdOverlay(); // visual-only countdown, see below
    const result = await api('/ads/fallback-complete', { method: 'POST' });
    if (result.error) {
      showToast(result.error === 'limit_reached' ? '🔒 Daily limit reached!' : '⚠️ ' + result.error);
    } else {
      showToast('+' + nanotonToTon(result.rewardNanoton) + ' TON earned! 🎉');
      tg?.HapticFeedback?.notificationOccurred('success');
    }
  }

  isWatching = false;
  await updateUI();
}

function showAdOverlay() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('adOverlay');
    overlay.classList.add('show');
    let t = 5;
    document.getElementById('adCountdown').textContent = t;
    document.getElementById('adProgFill').style.width = '0%';
    const interval = setInterval(() => {
      t--;
      document.getElementById('adCountdown').textContent = t;
      document.getElementById('adProgFill').style.width = ((5 - t) / 5) * 100 + '%';
      if (t <= 0) {
        clearInterval(interval);
        overlay.classList.remove('show');
        resolve();
      }
    }, 1000);
  });
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

// ════════ TASKS ════════
async function renderTasks() {
  const tasks = await api('/tasks');
  if (tasks.error) return;
  cache.tasks = tasks;

  const btnTT = document.getElementById('btn-tiktok');
  const btnTG = document.getElementById('btn-telegram');

  if (tasks.task_tiktok) {
    btnTT.textContent = '✅ Followed';
    btnTT.classList.add('done');
    btnTT.onclick = null;
  }
  if (tasks.task_telegram) {
    btnTG.textContent = '✅ Joined';
    btnTG.classList.add('done');
    btnTG.onclick = null;
  }
}

function doTask(taskId, url, isTelegramLink) {
  if (tg) {
    if (isTelegramLink && tg.openTelegramLink) tg.openTelegramLink(url);
    else if (tg.openLink) tg.openLink(url);
    else window.open(url, '_blank');
  } else {
    window.open(url, '_blank');
  }

  // Give the user a moment to actually join/follow before we check/claim.
  setTimeout(async () => {
    if (taskId === 'telegram') {
      const res = await api('/tasks/telegram/verify', { method: 'POST' });
      if (res.error === 'not_a_member') {
        showToast('⚠️ Not joined yet — try again after joining');
      } else if (res.ok) {
        showToast('🎉 Telegram joined! +20 bonus ads unlocked');
        renderTasks();
        updateUI();
      }
    } else if (taskId === 'tiktok') {
      const res = await api('/tasks/tiktok/claim', { method: 'POST' });
      if (res.ok) {
        showToast('🎉 TikTok followed! +20 bonus ads unlocked');
        renderTasks();
        updateUI();
      }
    }
  }, 3000);
}

// ════════ LEADERBOARD (real data) ════════
function setLbPeriod(p) {
  lbPeriod = p;
  document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.period === p));
  renderLeaderboard();
}

async function renderLeaderboard() {
  const data = await api('/leaderboard?period=' + lbPeriod);
  if (data.error) return;

  document.getElementById('yrRank').textContent = data.you.rank ? '#' + data.you.rank : '—';
  document.getElementById('yrAds').textContent = data.you.ads;

  const medals = ['🥇', '🥈', '🥉'];
  document.getElementById('lbList').innerHTML = data.leaderboard
    .map((r, i) => {
      const isYou = String(r.telegramId) === String(tgUserId);
      return `
      <div class="lb-row ${isYou ? 'is-you' : ''}" style="animation-delay:${i * 0.04}s">
        <div class="lb-rank ${i < 3 ? 'medal' : ''}">${i < 3 ? medals[i] : '#' + (i + 1)}</div>
        <div class="lb-avatar">👤</div>
        <div class="lb-name">${isYou ? '<span class="you-tag">You</span>' : r.name}</div>
        <div class="lb-ads">${r.ads}<small>ads</small></div>
      </div>`;
    })
    .join('');
}

// ════════ WALLET ════════
async function renderWallet() {
  const wallet = await api('/wallet');
  if (wallet.error) return;
  cache.wallet = wallet;

  const balance = wallet.balanceNanoton;
  const min = wallet.minWithdrawNanoton;
  document.getElementById('walletBalance').textContent = nanotonToTon(balance, 3);

  const pct = Math.min((Number(balance) / Number(min)) * 100, 100);
  document.getElementById('minProgFill').style.width = pct + '%';
  document.getElementById('minProgressPct').textContent = Math.floor(pct) + '%';

  const btn = document.getElementById('withdrawBtn');
  if (BigInt(balance) >= BigInt(min)) {
    btn.disabled = false;
    btn.innerHTML = '💸 Withdraw ' + nanotonToTon(balance, 2) + ' TON';
    document.getElementById('minProgressWrap').style.display = 'none';
  } else {
    btn.disabled = true;
    btn.innerHTML = '💸 Withdraw Funds';
    document.getElementById('minProgressWrap').style.display = 'block';
  }

  await renderHistory();

  // Admin panel is only fetched (and only succeeds) if the backend verifies
  // this Telegram ID is in ADMIN_TELEGRAM_IDS — purely cosmetic hiding on
  // the client wouldn't be real security, so the actual check lives server-side.
  const stats = await api('/admin/stats');
  if (!stats.error) {
    document.getElementById('adminPanel').style.display = 'block';
    renderAdminPanel(stats);
  }
}

async function withdraw() {
  const address = document.getElementById('tonAddress').value.trim();
  if (!address) { showToast('⚠️ Enter your TON wallet address'); return; }

  const res = await api('/wallet/withdraw', {
    method: 'POST',
    body: JSON.stringify({ tonAddress: address }),
  });

  if (res.error === 'below_minimum') {
    showToast('⚠️ Minimum withdrawal is ' + nanotonToTon(res.minWithdrawNanoton) + ' TON');
  } else if (res.error === 'invalid_address') {
    showToast('⚠️ Invalid TON address');
  } else if (res.error) {
    showToast('⚠️ ' + res.error);
  } else {
    showToast('✅ Withdrawal submitted! Processing shortly');
    await renderWallet();
    await updateUI();
  }
}

async function renderHistory() {
  const history = await api('/wallet/history');
  const list = document.getElementById('historyList');
  if (!Array.isArray(history) || history.length === 0) {
    list.innerHTML = '<div class="history-empty">No withdrawals yet</div>';
    return;
  }
  const icons = { paid: '✅', pending: '⏳', processing: '⏳', failed: '⚠️', rejected: '↩️' };
  list.innerHTML = history
    .map((h, i) => {
      const addr = h.ton_address.slice(0, 6) + '...' + h.ton_address.slice(-4);
      const date = new Date(h.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' });
      return `
      <div class="earning-item" style="animation-delay:${i * 0.06}s">
        <div class="ei-left">
          <div class="ei-icon">${icons[h.status] || '•'}</div>
          <div class="ei-info">
            <div class="ei-title">Withdrawal (${h.status})</div>
            <div class="ei-time">${date} • ${addr}</div>
          </div>
        </div>
        <div class="ei-amount neg">-${nanotonToTon(h.amount_nanoton, 2)} TON</div>
      </div>`;
    })
    .join('');
}

// ════════ ADMIN PANEL ════════
async function renderAdminPanel(stats) {
  document.getElementById('adminUsers').textContent = stats.totalUsers;
  document.getElementById('adminPending').textContent = stats.pendingWithdrawals;
  document.getElementById('adminPaid').textContent = nanotonToTon(stats.totalPaidNanoton, 2) + ' TON';
  document.getElementById('adminAds').textContent = stats.todayAds;

  const pending = await api('/admin/withdrawals?status=pending');
  const pList = document.getElementById('pendingList');
  if (!Array.isArray(pending) || pending.length === 0) {
    pList.innerHTML = '<div class="history-empty" style="padding:12px 0;">No pending withdrawals</div>';
    return;
  }
  pList.innerHTML = pending
    .map(
      (p) => `
    <div class="pending-item">
      <div class="pi-row">
        <div class="pi-name">${p.username || p.first_name || 'User'}</div>
        <div class="pi-amount">${nanotonToTon(p.amount_nanoton, 2)} TON</div>
      </div>
      <div class="pi-addr">${p.ton_address} • ${new Date(p.created_at).toLocaleString()}</div>
      <div class="pi-btns">
        <button class="pi-approve" onclick="adminApprove(${p.id})">✅ Approve</button>
        <button class="pi-reject" onclick="adminReject(${p.id})">❌ Reject</button>
      </div>
    </div>`
    )
    .join('');
}

async function adminApprove(id) {
  showToast('⏳ Sending TON on-chain…');
  const res = await api(`/admin/withdrawals/${id}/approve`, { method: 'POST' });
  if (res.error) {
    showToast('⚠️ Send failed — check tonscan.org before retrying');
  } else {
    showToast('✅ Withdrawal paid');
    renderWallet();
  }
}

async function adminReject(id) {
  const res = await api(`/admin/withdrawals/${id}/reject`, { method: 'POST' });
  if (!res.error) {
    showToast('❌ Rejected & balance refunded');
    renderWallet();
  }
}

// ════════ INIT ════════
updateUI();
renderTasks();
