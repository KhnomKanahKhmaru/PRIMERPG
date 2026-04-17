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
      <a href="#">My Characters</a>
      <a href="my-playgroups.html">My Playgroups</a>
      <a href="#">My Scenarios</a>
    </div>
  </div>
  <div class="topbar-item">
    Alerts
    <div class="dropdown">
      <a href="#">No alerts</a>
    </div>
  </div>
  <div class="topbar-item" style="margin-left:auto">
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
      <a href="#">Browse Rulesets</a>
    </div>
  </div>
  <div class="banner-item">
    Characters
    <div class="banner-dropdown">
      <a href="#">My Characters</a>
      <a href="create-character.html">Create Character</a>
    </div>
  </div>
</div>`;

const NAV_CSS = `
  .topbar {
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 44px;
    background: #111;
    border-bottom: 1px solid #222;
    display: flex;
    align-items: center;
    padding: 0 20px;
    gap: 4px;
    z-index: 100;
  }
  .topbar-item {
    position: relative;
    padding: 8px 14px;
    color: #aaa;
    cursor: pointer;
    font-size: 13px;
    border-radius: 4px;
    user-select: none;
  }
  .topbar-item:hover { color: #fff; background: #1e1e1e; }
  .topbar-item.home { color: #fff; font-weight: 600; margin-right: 10px; }
  .dropdown {
    display: none;
    position: absolute;
    top: 100%; left: 0;
    background: #111;
    border: 1px solid #222;
    border-radius: 4px;
    min-width: 160px;
    z-index: 200;
  }
  .topbar-item:hover .dropdown { display: block; }
  .dropdown a {
    display: block;
    padding: 9px 14px;
    color: #aaa;
    text-decoration: none;
    font-size: 13px;
  }
  .dropdown a:hover { color: #fff; background: #1e1e1e; }
  .dropdown-divider { border: none; border-top: 1px solid #222; margin: 4px 0; }
  .topbanner {
    position: fixed;
    top: 44px; left: 0; right: 0;
    height: 40px;
    background: #0e0e0e;
    border-bottom: 1px solid #1a1a1a;
    display: flex;
    align-items: center;
    padding: 0 20px;
    gap: 4px;
    z-index: 90;
  }
  .banner-item {
    position: relative;
    padding: 6px 14px;
    color: #666;
    cursor: pointer;
    font-size: 12px;
    border-radius: 4px;
    user-select: none;
  }
  .banner-item:hover { color: #ccc; background: #1a1a1a; }
  .banner-dropdown {
    display: none;
    position: absolute;
    top: 100%; left: 0;
    background: #111;
    border: 1px solid #222;
    border-radius: 4px;
    min-width: 160px;
    z-index: 200;
  }
  .banner-item:hover .banner-dropdown { display: block; }
  .banner-dropdown a {
    display: block;
    padding: 9px 14px;
    color: #aaa;
    text-decoration: none;
    font-size: 13px;
  }
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
