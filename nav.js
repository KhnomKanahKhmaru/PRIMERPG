const NAV_HTML = `
<div class="topbar">
  <div class="topbar-item home" onclick="window.location.href='home.html'">PRIME RPG</div>
  <div class="topbar-item" onclick="window.location.href='home.html'">Home</div>
  <div class="topbar-item">
    Documentation
    <div class="dropdown">
      <a href="#">Rules</a>
      <a href="#">Combat</a>
      <a href="#">Characters</a>
    </div>
  </div>
  <div class="topbar-item">
    Navigation
    <div class="dropdown">
      <a href="my-characters.html">My Characters</a>
      <a href="my-playgroups.html">My Playgroups</a>
      <a href="#">My Scenarios</a>
    </div>
  </div>
  <div class="topbar-item" id="nav-alerts-item" style="margin-left:auto;position:relative">
    <span>Alerts</span>
    <span id="nav-alerts-badge" class="nav-alerts-badge" style="display:none">0</span>
    <div class="dropdown dropdown-alerts" style="left:auto;right:0;min-width:360px;max-width:400px" id="nav-alerts-dropdown">
      <div id="nav-alerts-list"><div class="alerts-empty">No alerts</div></div>
      <div class="alerts-footer" id="nav-alerts-footer" style="display:none">
        <a href="#" onclick="markAllAlertsRead();return false">Mark all read</a>
        <span class="alerts-footer-sep">·</span>
        <a href="#" onclick="clearAllAlerts();return false" class="danger">Clear all</a>
      </div>
    </div>
  </div>
  <div class="topbar-item">
    <span id="nav-username">...</span>
    <div class="dropdown" style="left:auto;right:0">
      <a href="#">View Account</a>
      <a href="#">Account Settings</a>
      <a href="#">Messages</a>
      <hr class="dropdown-divider">
      <a href="#" onclick="logout()">Log Out</a>
    </div>
  </div>
</div>

<div class="topbanner">
  <div class="banner-item">
    Sessions
    <div class="banner-dropdown">
      <a href="#">Log Session</a>
    </div>
  </div>
  <div class="banner-item">
    Playgroups
    <div class="banner-dropdown">
      <a href="create-playgroup.html">Create Playgroup</a>
      <a href="browse-playgroups.html">Browse Playgroups</a>
    </div>
  </div>
  <div class="banner-item">
    Scenarios
    <div class="banner-dropdown">
      <a href="#">My Scenarios</a>
      <a href="#">Browse Scenarios</a>
    </div>
  </div>
  <div class="banner-item">
    Abilities
    <div class="banner-dropdown">
      <a href="#">My Abilities</a>
    </div>
  </div>
  <div class="banner-item">
    Rulesets
    <div class="banner-dropdown">
      <a href="create-ruleset.html">Create Ruleset</a>
      <a href="my-rulesets.html">My Rulesets</a>
      <a href="#">Browse Rulesets</a>
    </div>
  </div>
  <div class="banner-item">
    Characters
    <div class="banner-dropdown">
      <a href="my-characters.html">My Characters</a>
      <a href="create-character.html">Create Character</a>
    </div>
  </div>
</div>`;

const NAV_CSS = `
  .topbar { position: fixed; top: 0; left: 0; right: 0; height: 44px; background: #111; border-bottom: 1px solid #222; display: flex; align-items: center; padding: 0 20px; gap: 4px; z-index: 100; }
  .topbar-item { position: relative; padding: 8px 14px; color: #aaa; cursor: pointer; font-size: 13px; border-radius: 4px; user-select: none; }
  .topbar-item:hover { color: #fff; background: #1e1e1e; }
  .topbar-item.home { color: #fff; font-weight: 600; margin-right: 10px; }
  .dropdown { display: none; position: absolute; top: 100%; left: 0; background: #111; border: 1px solid #222; border-radius: 4px; min-width: 160px; z-index: 200; }
  .topbar-item:hover .dropdown { display: block; }
  .dropdown a { display: block; padding: 9px 14px; color: #aaa; text-decoration: none; font-size: 13px; }
  .dropdown a:hover { color: #fff; background: #1e1e1e; }
  .dropdown-divider { border: none; border-top: 1px solid #222; margin: 4px 0; }

  /* Alerts dropdown */
  .nav-alerts-badge {
    display: inline-block;
    margin-left: 6px;
    background: #c84b4b;
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 8px;
    min-width: 18px;
    text-align: center;
    line-height: 1.4;
  }
  .dropdown-alerts { padding: 4px 0; }
  .alert-item {
    padding: 10px 14px;
    border-bottom: 1px solid #1a1a1a;
    font-size: 12px;
    color: #bbb;
    line-height: 1.5;
    position: relative;
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
  .alert-item:last-child { border-bottom: none; }
  .alert-item.unread { background: #151a20; }
  .alert-item.unread::before {
    content: '';
    display: block;
    width: 6px;
    height: 6px;
    background: #5ba3e0;
    border-radius: 50%;
    margin-top: 6px;
    flex-shrink: 0;
  }
  .alert-item:not(.unread)::before {
    content: '';
    display: block;
    width: 6px;
    height: 6px;
    flex-shrink: 0;
  }
  .alert-body { flex: 1; min-width: 0; }
  .alert-text { color: #ccc; margin-bottom: 3px; }
  .alert-text strong { color: #fff; font-weight: 600; }
  .alert-time { font-size: 10px; color: #666; }
  .alert-dismiss {
    color: #555;
    font-size: 14px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
    flex-shrink: 0;
  }
  .alert-dismiss:hover { color: #c84b4b; }
  .alerts-empty { padding: 16px 14px; color: #555; font-size: 12px; text-align: center; font-style: italic; }
  .alerts-footer {
    padding: 8px 14px;
    border-top: 1px solid #1a1a1a;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
  }
  .alerts-footer a { color: #888; text-decoration: none; padding: 0; }
  .alerts-footer a:hover { color: #fff; background: transparent; }
  .alerts-footer a.danger { color: #a66; }
  .alerts-footer a.danger:hover { color: #e88; }
  .alerts-footer-sep { color: #333; }

  .topbanner { position: fixed; top: 44px; left: 0; right: 0; height: 40px; background: #0e0e0e; border-bottom: 1px solid #1a1a1a; display: flex; align-items: center; padding: 0 20px; gap: 4px; z-index: 90; }
  .banner-item { position: relative; padding: 6px 14px; color: #666; cursor: pointer; font-size: 12px; border-radius: 4px; user-select: none; }
  .banner-item:hover { color: #ccc; background: #1a1a1a; }
  .banner-dropdown { display: none; position: absolute; top: 100%; left: 0; background: #111; border: 1px solid #222; border-radius: 4px; min-width: 160px; z-index: 200; }
  .banner-item:hover .banner-dropdown { display: block; }
  .banner-dropdown a { display: block; padding: 9px 14px; color: #aaa; text-decoration: none; font-size: 13px; }
  .banner-dropdown a:hover { color: #fff; background: #1e1e1e; }`;

function injectNav() {
  const style = document.createElement('style');
  style.textContent = NAV_CSS;
  document.head.appendChild(style);
  const div = document.createElement('div');
  div.innerHTML = NAV_HTML;
  document.body.insertBefore(div.firstElementChild, document.body.firstChild);
  document.body.insertBefore(div.firstElementChild, document.body.children[1]);
}

function setNavUsername(username) {
  const el = document.getElementById('nav-username');
  if (el) el.textContent = username;
}

// ── ALERTS SYSTEM ──
// Alerts are stored in Firestore: alerts/{alertId}
// Fields: { uid, text, createdAt, read, link }
//   - uid: recipient user ID
//   - text: alert message (plain text, may contain **bold** markers)
//   - createdAt: Firestore Timestamp (or number)
//   - read: boolean
//   - link: optional URL to navigate to when clicked

let _navAlertsDb = null;
let _navAlertsUid = null;
let _navAlertsCache = [];

function _formatAlertTime(ts) {
  if (!ts) return '';
  const then = ts.toMillis ? ts.toMillis() : (typeof ts === 'number' ? ts : Date.parse(ts));
  const diff = Date.now() - then;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  if (h < 24) return h + 'h ago';
  if (d < 7) return d + 'd ago';
  return new Date(then).toLocaleDateString();
}

function _renderAlerts() {
  const list = document.getElementById('nav-alerts-list');
  const footer = document.getElementById('nav-alerts-footer');
  const badge = document.getElementById('nav-alerts-badge');
  if (!list) return;

  const unreadCount = _navAlertsCache.filter(a => !a.read).length;
  if (unreadCount > 0) {
    badge.textContent = unreadCount;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }

  if (_navAlertsCache.length === 0) {
    list.innerHTML = '<div class="alerts-empty">No alerts</div>';
    footer.style.display = 'none';
    return;
  }

  footer.style.display = 'flex';
  list.innerHTML = _navAlertsCache.map(a => {
    const text = (a.text || '').replace(/</g, '&lt;').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    const time = _formatAlertTime(a.createdAt);
    const onClick = a.link ? `onclick="markAlertReadAndGo('${a.id}','${a.link.replace(/'/g,"\\'")}')"` : `onclick="markAlertRead('${a.id}')"`;
    return `<div class="alert-item ${a.read ? '' : 'unread'}" style="cursor:pointer" ${onClick}>
      <div class="alert-body">
        <div class="alert-text">${text}</div>
        <div class="alert-time">${time}</div>
      </div>
      <span class="alert-dismiss" onclick="event.stopPropagation();dismissAlert('${a.id}')" title="Dismiss">×</span>
    </div>`;
  }).join('');
}

async function initAlerts(db, uid) {
  _navAlertsDb = db;
  _navAlertsUid = uid;
  const mod = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js');
  try {
    const q = mod.query(mod.collection(db, 'alerts'), mod.where('uid', '==', uid));
    const snap = await mod.getDocs(q);
    _navAlertsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _navAlertsCache.sort((a, b) => {
      const at = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
      const bt = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
      return bt - at;
    });
    _renderAlerts();
  } catch (e) {
    console.error('Failed to load alerts:', e);
  }
}

async function createAlert(db, uid, text, link) {
  const mod = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js');
  try {
    await mod.addDoc(mod.collection(db, 'alerts'), {
      uid,
      text,
      read: false,
      link: link || null,
      createdAt: mod.serverTimestamp()
    });
  } catch (e) {
    console.error('Failed to create alert:', e);
  }
}

window.markAlertRead = async function(id) {
  const alert = _navAlertsCache.find(a => a.id === id);
  if (!alert || alert.read) return;
  alert.read = true;
  _renderAlerts();
  const mod = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js');
  try { await mod.updateDoc(mod.doc(_navAlertsDb, 'alerts', id), { read: true }); }
  catch (e) { console.error(e); }
}

window.markAlertReadAndGo = async function(id, link) {
  await window.markAlertRead(id);
  window.location.href = link;
}

window.dismissAlert = async function(id) {
  _navAlertsCache = _navAlertsCache.filter(a => a.id !== id);
  _renderAlerts();
  const mod = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js');
  try { await mod.deleteDoc(mod.doc(_navAlertsDb, 'alerts', id)); }
  catch (e) { console.error(e); }
}

window.markAllAlertsRead = async function() {
  const mod = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js');
  const unread = _navAlertsCache.filter(a => !a.read);
  for (const a of unread) {
    a.read = true;
    try { await mod.updateDoc(mod.doc(_navAlertsDb, 'alerts', a.id), { read: true }); }
    catch (e) { console.error(e); }
  }
  _renderAlerts();
}

window.clearAllAlerts = async function() {
  if (!confirm('Clear all alerts? This cannot be undone.')) return;
  const mod = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js');
  const toDelete = _navAlertsCache.slice();
  _navAlertsCache = [];
  _renderAlerts();
  for (const a of toDelete) {
    try { await mod.deleteDoc(mod.doc(_navAlertsDb, 'alerts', a.id)); }
    catch (e) { console.error(e); }
  }
}

window.initAlerts = initAlerts;
window.createAlert = createAlert;
