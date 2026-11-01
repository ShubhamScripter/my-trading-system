import { AdminAPI } from './api.js';

// State
let currentTab = 'overview';
let cachedRooms = [];
let cachedReports = [];
let cachedBans = [];
let cachedCosmetics = [];

// DOM Elements
const views = {
  overview: document.getElementById('view-overview'),
  rooms: document.getElementById('view-rooms'),
  rules: document.getElementById('view-rules'),
  reports: document.getElementById('view-reports'),
  bans: document.getElementById('view-bans'),
  cosmetics: document.getElementById('view-cosmetics'),
  broadcast: document.getElementById('view-broadcast'),
};

// ──────────────────────── TOAST SYSTEM ────────────────────────
export function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  const icon = type === 'success' ? '✅' : type === 'danger' ? '⚠️' : 'ℹ️';
  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ──────────────────────── TAB NAVIGATION ────────────────────────
function switchTab(tabName) {
  currentTab = tabName;

  // Update nav items
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.tab === tabName);
  });

  // Update visible view
  Object.keys(views).forEach((key) => {
    if (views[key]) {
      views[key].style.display = key === tabName ? 'block' : 'none';
    }
  });

  // Load data for the selected view
  if (tabName === 'overview') loadOverview();
  if (tabName === 'rooms') loadRooms();
  if (tabName === 'rules') loadRulesView();
  if (tabName === 'reports') loadReports();
  if (tabName === 'bans') loadBans();
  if (tabName === 'cosmetics') loadCosmetics();
}

// ──────────────────────── OVERVIEW ────────────────────────
async function loadOverview() {
  const stats = await AdminAPI.getStats();
  if (stats) {
    document.getElementById('stat-rooms').textContent = stats.activeRooms ?? 4;
    document.getElementById('stat-users').textContent = stats.totalOnlineUsers ?? 607;
    document.getElementById('stat-messages').textContent = (stats.totalMessages ?? 34720).toLocaleString();
    document.getElementById('stat-reports').textContent = stats.pendingReports ?? 2;
    document.getElementById('stat-bans').textContent = stats.activeBans ?? 1;
    document.getElementById('stat-cosmetics').textContent = stats.totalCosmetics ?? 4;

    const reportBadge = document.getElementById('nav-counter-reports');
    if (reportBadge) {
      reportBadge.textContent = stats.pendingReports ?? 0;
      reportBadge.style.display = stats.pendingReports > 0 ? 'inline-block' : 'none';
    }
  }

  // Load quick room snapshot
  await loadRoomsSnapshot();
}

async function loadRoomsSnapshot() {
  const rooms = await AdminAPI.getRooms();
  if (!rooms) return;
  cachedRooms = rooms;

  const tbody = document.getElementById('overview-rooms-tbody');
  if (!tbody) return;

  tbody.innerHTML = rooms.slice(0, 4).map((r) => `
    <tr>
      <td>
        <div class="room-identity">
          <div class="room-icon-badge">${getRoomIcon(r.type)}</div>
          <div class="room-names">
            <h4>${escapeHtml(r.name)}</h4>
            <span>slug: ${escapeHtml(r.slug)}</span>
          </div>
        </div>
      </td>
      <td><span class="tag-badge ${getTypeBadgeClass(r.type)}">${r.type}</span></td>
      <td><strong>${r.onlineCount ?? 0}</strong> online</td>
      <td>
        <span style="color: ${r.isActive ? 'var(--success)' : 'var(--text-muted)'}; font-weight: 600;">
          ${r.isActive ? '● Active' : '○ Disabled'}
        </span>
      </td>
      <td>
        <button class="btn-secondary" style="padding: 5px 10px; font-size: 11px;" onclick="window.manageRoom('${r.id}')">
          Configure
        </button>
      </td>
    </tr>
  `).join('');
}

// ──────────────────────── ROOMS MANAGEMENT ────────────────────────
async function loadRooms() {
  const rooms = await AdminAPI.getRooms();
  if (rooms) cachedRooms = rooms;

  const tbody = document.getElementById('rooms-tbody');
  if (!tbody) return;

  tbody.innerHTML = cachedRooms.map((r) => {
    const cc = r.contentControls || {};
    return `
      <tr data-room-id="${r.id}">
        <td>
          <div class="room-identity">
            <div class="room-icon-badge">${getRoomIcon(r.type)}</div>
            <div class="room-names">
              <h4>${escapeHtml(r.name)}</h4>
              <span>/${escapeHtml(r.slug)} • ${r.language || 'EN'}</span>
            </div>
          </div>
        </td>
        <td><span class="tag-badge ${getTypeBadgeClass(r.type)}">${r.type}</span></td>
        
        <!-- Module 3.2.1 Content Toggles -->
        <td style="text-align: center;">
          <label class="toggle-switch">
            <input type="checkbox" ${cc.allowText !== false ? 'checked' : ''} onchange="window.toggleRoomControl('${r.id}', 'allowText', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td style="text-align: center;">
          <label class="toggle-switch">
            <input type="checkbox" ${cc.allowGif !== false ? 'checked' : ''} onchange="window.toggleRoomControl('${r.id}', 'allowGif', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td style="text-align: center;">
          <label class="toggle-switch">
            <input type="checkbox" ${cc.allowImage !== false ? 'checked' : ''} onchange="window.toggleRoomControl('${r.id}', 'allowImage', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td style="text-align: center;">
          <label class="toggle-switch">
            <input type="checkbox" ${cc.allowVideo ? 'checked' : ''} onchange="window.toggleRoomControl('${r.id}', 'allowVideo', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td style="text-align: center;">
          <label class="toggle-switch">
            <input type="checkbox" ${cc.allowEmoji !== false ? 'checked' : ''} onchange="window.toggleRoomControl('${r.id}', 'allowEmoji', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td style="text-align: center;">
          <label class="toggle-switch">
            <input type="checkbox" ${cc.autoModeration !== false ? 'checked' : ''} onchange="window.toggleRoomControl('${r.id}', 'autoModeration', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
        
        <td>
          <div style="display: flex; gap: 8px;">
            <button class="btn-secondary" style="padding: 6px 10px; font-size: 11px;" onclick="window.editRoomRules('${r.id}')">
              📜 Rules
            </button>
            <button class="btn-danger" style="padding: 6px 10px; font-size: 11px;" onclick="window.deleteRoom('${r.id}')">
              Disable
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

window.toggleRoomControl = async (roomId, controlKey, value) => {
  try {
    const res = await AdminAPI.updateRoomControls(roomId, { [controlKey]: value });
    if (res.success) {
      showToast(`Updated ${controlKey} to ${value ? 'Allowed' : 'Restricted'}`);
    } else {
      showToast(res.error || 'Failed to update control', 'danger');
    }
  } catch (err) {
    showToast('Failed to connect to admin backend', 'danger');
  }
};

window.deleteRoom = async (roomId) => {
  if (!confirm('Are you sure you want to deactivate this chat room?')) return;
  try {
    const res = await AdminAPI.deleteRoom(roomId);
    if (res.success) {
      showToast('Room deactivated');
      loadRooms();
    }
  } catch {
    showToast('Failed to deactivate room', 'danger');
  }
};

// ──────────────────────── RULES STUDIO ────────────────────────
async function loadRulesView() {
  const select = document.getElementById('rules-room-select');
  if (!select) return;

  if (cachedRooms.length === 0) {
    cachedRooms = (await AdminAPI.getRooms()) || [];
  }

  select.innerHTML = cachedRooms.map((r) => `
    <option value="${r.id}">${escapeHtml(r.name)} (${r.type})</option>
  `).join('');

  select.onchange = () => displayRoomRules(select.value);
  if (cachedRooms.length > 0) {
    displayRoomRules(cachedRooms[0].id);
  }
}

async function displayRoomRules(roomId) {
  const container = document.getElementById('rules-list-container');
  if (!container) return;

  try {
    const data = await AdminAPI.getRules(roomId);
    const rules = data.rules || [];

    container.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 12px;">
        ${rules.map((rule, idx) => `
          <div style="display: flex; gap: 10px; align-items: center;">
            <span style="color: var(--primary); font-weight: 700; width: 24px;">#${idx + 1}</span>
            <input type="text" class="form-control rule-input-item" style="flex: 1;" value="${escapeHtml(rule)}" />
            <button class="btn-danger" style="padding: 8px 12px;" onclick="this.parentElement.remove()">✕</button>
          </div>
        `).join('')}
      </div>
      <div style="margin-top: 16px; display: flex; gap: 12px;">
        <button class="btn-secondary" onclick="window.addRuleItem()">+ Add Another Rule</button>
        <button class="btn-action" onclick="window.saveRoomRules('${roomId}')">Save Rules for Room</button>
      </div>
    `;
  } catch {
    container.innerHTML = '<p style="color: var(--danger);">Failed to load rules.</p>';
  }
}

window.addRuleItem = () => {
  const list = document.querySelector('#rules-list-container > div');
  if (!list) return;
  const count = list.children.length + 1;
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = '10px';
  row.style.alignItems = 'center';
  row.innerHTML = `
    <span style="color: var(--primary); font-weight: 700; width: 24px;">#${count}</span>
    <input type="text" class="form-control rule-input-item" style="flex: 1;" placeholder="Enter new community rule..." />
    <button class="btn-danger" style="padding: 8px 12px;" onclick="this.parentElement.remove()">✕</button>
  `;
  list.appendChild(row);
};

window.saveRoomRules = async (roomId) => {
  const inputs = document.querySelectorAll('.rule-input-item');
  const rules = Array.from(inputs).map((i) => i.value.trim()).filter(Boolean);

  try {
    const res = await AdminAPI.updateRules(roomId, rules);
    if (res.success) {
      showToast('Room rules updated successfully');
    } else {
      showToast(res.error || 'Failed to save rules', 'danger');
    }
  } catch {
    showToast('Network error saving rules', 'danger');
  }
};

window.editRoomRules = (roomId) => {
  switchTab('rules');
  const select = document.getElementById('rules-room-select');
  if (select) {
    select.value = roomId;
    displayRoomRules(roomId);
  }
};

// ──────────────────────── REPORTS QUEUE ────────────────────────
async function loadReports(status = 'ALL') {
  const reports = await AdminAPI.getReports(status);
  if (reports) cachedReports = reports;

  const tbody = document.getElementById('reports-tbody');
  if (!tbody) return;

  if (cachedReports.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 40px; color: var(--text-muted);">No reports found in this queue.</td></tr>`;
    return;
  }

  tbody.innerHTML = cachedReports.map((r) => `
    <tr>
      <td>
        <span class="tag-badge" style="background: rgba(255, 51, 102, 0.15); color: #ff3366; border: 1px solid rgba(255, 51, 102, 0.3);">
          ${r.reason}
        </span>
      </td>
      <td>
        <div style="max-width: 260px; font-size: 13px; color: #fff; background: rgba(0,0,0,0.3); padding: 8px 12px; border-radius: 6px; border-left: 2px solid var(--danger);">
          "${escapeHtml(r.messageContent)}"
        </div>
        ${r.details ? `<span style="font-size: 11px; color: var(--text-muted); display: block; margin-top: 4px;">Context: ${escapeHtml(r.details)}</span>` : ''}
      </td>
      <td>
        <strong>${escapeHtml(r.reportedUsername)}</strong>
        <span style="font-size: 11px; color: var(--text-muted); display: block;">by ${escapeHtml(r.reporterUsername)}</span>
      </td>
      <td>${escapeHtml(r.roomName)}</td>
      <td>
        <span style="font-size: 11px; font-weight: 700; color: ${r.status === 'PENDING' ? 'var(--warning)' : r.status === 'ACTIONED' ? 'var(--success)' : 'var(--text-muted)'};">
          ${r.status}
        </span>
      </td>
      <td>
        ${r.status === 'PENDING' ? `
          <div style="display: flex; gap: 6px;">
            <button class="btn-success" onclick="window.actionReport('${r.id}', 'DISMISS')">Dismiss</button>
            <button class="btn-secondary" onclick="window.actionReport('${r.id}', 'DELETE_MESSAGE')">Retract</button>
            <button class="btn-danger" onclick="window.actionReport('${r.id}', 'BAN_USER')">Ban 24h</button>
          </div>
        ` : `
          <span style="font-size: 11px; color: var(--text-muted);">${escapeHtml(r.actionTaken || 'Closed')}</span>
        `}
      </td>
    </tr>
  `).join('');
}

window.actionReport = async (reportId, action) => {
  const reason = prompt(`Optional reason for ${action}:`, `Violation of chat policies`);
  try {
    const res = await AdminAPI.actionReport(reportId, action, reason || undefined);
    if (res.success) {
      showToast(`Action ${action} recorded!`);
      loadReports();
      loadOverview();
    }
  } catch {
    showToast('Failed to action report', 'danger');
  }
};

// ──────────────────────── BANS ────────────────────────
async function loadBans() {
  const bans = await AdminAPI.getBans();
  if (bans) cachedBans = bans;

  const tbody = document.getElementById('bans-tbody');
  if (!tbody) return;

  if (cachedBans.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 40px; color: var(--text-muted);">No active bans.</td></tr>`;
    return;
  }

  tbody.innerHTML = cachedBans.map((b) => `
    <tr>
      <td><strong>${escapeHtml(b.username)}</strong><br><span style="font-size: 11px; color: var(--text-muted);">ID: ${b.userId}</span></td>
      <td>${escapeHtml(b.roomName || 'Global (All Rooms)')}</td>
      <td>${escapeHtml(b.reason)}</td>
      <td>${new Date(b.bannedAt).toLocaleDateString()}</td>
      <td>
        <span style="color: ${b.isActive ? 'var(--danger)' : 'var(--text-muted)'}; font-weight: 700;">
          ${b.isActive ? `Active (Expires: ${new Date(b.expiresAt).toLocaleTimeString()})` : 'Expired / Revoked'}
        </span>
      </td>
      <td>
        ${b.isActive ? `
          <button class="btn-secondary" style="padding: 6px 12px; font-size: 11px;" onclick="window.unbanUser('${b.id}')">
            Unban User
          </button>
        ` : '—'}
      </td>
    </tr>
  `).join('');
}

window.unbanUser = async (banId) => {
  if (!confirm('Unban this user immediately?')) return;
  try {
    const res = await AdminAPI.unbanUser(banId);
    if (res.success) {
      showToast('User unbanned');
      loadBans();
      loadOverview();
    }
  } catch {
    showToast('Failed to unban user', 'danger');
  }
};

// ──────────────────────── COSMETICS STUDIO ────────────────────────
async function loadCosmetics() {
  const cosmetics = await AdminAPI.getCosmetics();
  if (cosmetics) cachedCosmetics = cosmetics;

  const grid = document.getElementById('cosmetics-grid');
  if (!grid) return;

  grid.innerHTML = cachedCosmetics.map((c) => `
    <div class="cosmetic-card">
      <div class="cosmetic-preview-bubble" style="background: ${c.gradient}; border: 1.5px solid ${c.borderColor};">
        <div class="bubble-sender" style="color: #fff;">
          <span>${c.badgeIcon}</span>
          <span>SampleUser</span>
          <span style="font-size: 10px; background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px;">VIP</span>
        </div>
        <p style="color: #fff; font-weight: 500;">This is how messages with the ${escapeHtml(c.name)} skin look in live chat!</p>
      </div>
      <div class="cosmetic-info">
        <div class="cosmetic-title-row">
          <h4>${escapeHtml(c.name)}</h4>
          <span class="cosmetic-price">${c.cost > 0 ? `$${c.cost.toFixed(2)}` : 'FREE'}</span>
        </div>
        <p style="font-size: 12px; color: var(--text-secondary);">${escapeHtml(c.description)}</p>
        <div style="display: flex; gap: 8px; margin-top: 10px; align-items: center;">
          <span class="tag-badge ${c.isPremium ? 'tag-vip' : 'tag-global'}">
            ${c.isPremium ? 'Premium Exclusive' : 'Public Store'}
          </span>
          <button class="btn-danger" style="margin-left: auto; padding: 4px 10px; font-size: 11px;" onclick="window.deleteCosmetic('${c.id}')">
            Delete
          </button>
        </div>
      </div>
    </div>
  `).join('');
}

window.deleteCosmetic = async (id) => {
  if (!confirm('Delete this cosmetic skin?')) return;
  try {
    const res = await AdminAPI.deleteCosmetic(id);
    if (res.success) {
      showToast('Cosmetic deleted');
      loadCosmetics();
    }
  } catch {
    showToast('Failed to delete cosmetic', 'danger');
  }
};

// ──────────────────────── BROADCAST STUDIO ────────────────────────
function setupBroadcastForm() {
  const form = document.getElementById('broadcast-form');
  if (!form) return;

  form.onsubmit = async (e) => {
    e.preventDefault();
    const type = document.getElementById('bc-type').value;
    const title = document.getElementById('bc-title').value;
    const content = document.getElementById('bc-content').value;
    const roomId = document.getElementById('bc-room').value;

    if (!content.trim()) {
      showToast('Please enter announcement message content', 'danger');
      return;
    }

    try {
      const res = await AdminAPI.sendBroadcast({
        type,
        title,
        content,
        roomId: roomId || undefined,
      });

      if (res.success) {
        showToast('🚀 Announcement broadcast sent to chat!');
        form.reset();
      } else {
        showToast(res.error || 'Broadcast failed', 'danger');
      }
    } catch {
      showToast('Network error sending broadcast', 'danger');
    }
  };
}

// ──────────────────────── MODAL LOGIC ────────────────────────
function setupModals() {
  // Create Room Modal
  const createRoomModal = document.getElementById('modal-create-room');
  const btnOpenCreateRoom = document.getElementById('btn-open-create-room');
  const btnCloseCreateRoom = document.getElementById('btn-close-create-room');
  const formCreateRoom = document.getElementById('form-create-room');

  if (btnOpenCreateRoom && createRoomModal) {
    btnOpenCreateRoom.onclick = () => createRoomModal.classList.add('open');
  }
  if (btnCloseCreateRoom && createRoomModal) {
    btnCloseCreateRoom.onclick = () => createRoomModal.classList.remove('open');
  }

  if (formCreateRoom) {
    formCreateRoom.onsubmit = async (e) => {
      e.preventDefault();
      const name = document.getElementById('new-room-name').value;
      const slug = document.getElementById('new-room-slug').value;
      const type = document.getElementById('new-room-type').value;
      const description = document.getElementById('new-room-desc').value;
      const language = document.getElementById('new-room-lang').value;

      try {
        const res = await AdminAPI.createRoom({
          name,
          slug,
          type,
          description,
          language,
        });
        if (res.success) {
          showToast(`Room "${name}" created successfully!`);
          createRoomModal.classList.remove('open');
          formCreateRoom.reset();
          loadRooms();
          loadOverview();
        } else {
          showToast(res.error || 'Failed to create room', 'danger');
        }
      } catch {
        showToast('Network error creating room', 'danger');
      }
    };
  }

  // Create Cosmetic Modal
  const createCosmModal = document.getElementById('modal-create-cosmetic');
  const btnOpenCreateCosm = document.getElementById('btn-open-create-cosm');
  const btnCloseCreateCosm = document.getElementById('btn-close-create-cosm');
  const formCreateCosm = document.getElementById('form-create-cosm');

  if (btnOpenCreateCosm && createCosmModal) {
    btnOpenCreateCosm.onclick = () => createCosmModal.classList.add('open');
  }
  if (btnCloseCreateCosm && createCosmModal) {
    btnCloseCreateCosm.onclick = () => createCosmModal.classList.remove('open');
  }

  if (formCreateCosm) {
    formCreateCosm.onsubmit = async (e) => {
      e.preventDefault();
      const name = document.getElementById('new-cosm-name').value;
      const description = document.getElementById('new-cosm-desc').value;
      const gradient = document.getElementById('new-cosm-gradient').value;
      const borderColor = document.getElementById('new-cosm-border').value;
      const badgeIcon = document.getElementById('new-cosm-icon').value;
      const cost = Number(document.getElementById('new-cosm-cost').value) || 0;
      const isPremium = document.getElementById('new-cosm-premium').checked;

      try {
        const res = await AdminAPI.createCosmetic({
          name,
          description,
          gradient,
          borderColor,
          badgeIcon,
          cost,
          isPremium,
        });
        if (res.success) {
          showToast(`Chat Skin "${name}" created!`);
          createCosmModal.classList.remove('open');
          formCreateCosm.reset();
          loadCosmetics();
        }
      } catch {
        showToast('Failed to create skin', 'danger');
      }
    };
  }

  // Issue Ban Modal
  const issueBanModal = document.getElementById('modal-issue-ban');
  const btnOpenIssueBan = document.getElementById('btn-open-issue-ban');
  const btnCloseIssueBan = document.getElementById('btn-close-issue-ban');
  const formIssueBan = document.getElementById('form-issue-ban');

  if (btnOpenIssueBan && issueBanModal) {
    btnOpenIssueBan.onclick = () => issueBanModal.classList.add('open');
  }
  if (btnCloseIssueBan && issueBanModal) {
    btnCloseIssueBan.onclick = () => issueBanModal.classList.remove('open');
  }

  if (formIssueBan) {
    formIssueBan.onsubmit = async (e) => {
      e.preventDefault();
      const userId = document.getElementById('ban-user-id').value;
      const username = document.getElementById('ban-username').value;
      const reason = document.getElementById('ban-reason').value;
      const durationHours = Number(document.getElementById('ban-duration').value) || 24;

      try {
        const res = await AdminAPI.createBan({
          userId,
          username,
          reason,
          durationHours,
        });
        if (res.success) {
          showToast(`User ${username} banned for ${durationHours} hours`);
          issueBanModal.classList.remove('open');
          formIssueBan.reset();
          loadBans();
          loadOverview();
        }
      } catch {
        showToast('Failed to issue ban', 'danger');
      }
    };
  }
}

// Helpers
function getRoomIcon(type) {
  switch (type) {
    case 'GLOBAL': return '🌐';
    case 'PREMIUM': return '👑';
    case 'CASINO': return '🎰';
    case 'COUNTRY': return '🚩';
    case 'KYC': return '🛡️';
    case 'SO': return '💼';
    default: return '💬';
  }
}

function getTypeBadgeClass(type) {
  switch (type) {
    case 'GLOBAL': return 'tag-global';
    case 'PREMIUM': return 'tag-vip';
    case 'CASINO': return 'tag-casino';
    case 'COUNTRY': return 'tag-country';
    default: return 'tag-global';
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ──────────────────────── INITIALIZATION ────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Nav Click Handlers
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = item.dataset.tab;
      if (tab) switchTab(tab);
    });
  });

  setupModals();
  setupBroadcastForm();
  switchTab('overview');
});
