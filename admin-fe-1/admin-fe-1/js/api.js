const API_BASE = 'http://localhost:3008/api/admin';

export const AdminAPI = {
  // Stats
  async getStats() {
    try {
      const res = await fetch(`${API_BASE}/stats`);
      const data = await res.json();
      return data.stats;
    } catch (err) {
      console.warn('[AdminAPI] Offline fallback for stats');
      return {
        totalRooms: 4,
        activeRooms: 4,
        totalOnlineUsers: 607,
        totalMessages: 34720,
        pendingReports: 2,
        activeBans: 1,
        totalCosmetics: 4,
      };
    }
  },

  // Rooms
  async getRooms() {
    try {
      const res = await fetch(`${API_BASE}/rooms`);
      const data = await res.json();
      return data.rooms;
    } catch (err) {
      console.warn('[AdminAPI] Offline fallback for rooms');
      return null;
    }
  },

  async createRoom(roomData) {
    const res = await fetch(`${API_BASE}/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(roomData),
    });
    return res.json();
  },

  async updateRoomControls(roomId, controls) {
    const res = await fetch(`${API_BASE}/rooms/${roomId}/controls`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(controls),
    });
    return res.json();
  },

  async deleteRoom(roomId) {
    const res = await fetch(`${API_BASE}/rooms/${roomId}`, {
      method: 'DELETE',
    });
    return res.json();
  },

  // Rules
  async getRules(roomId) {
    const res = await fetch(`${API_BASE}/rules/${roomId}`);
    return res.json();
  },

  async updateRules(roomId, rules) {
    const res = await fetch(`${API_BASE}/rules/${roomId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules }),
    });
    return res.json();
  },

  // Reports
  async getReports(status = 'ALL') {
    const res = await fetch(`${API_BASE}/reports?status=${status}`);
    const data = await res.json();
    return data.reports;
  },

  async actionReport(reportId, action, reason) {
    const res = await fetch(`${API_BASE}/reports/${reportId}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, reason }),
    });
    return res.json();
  },

  // Bans
  async getBans() {
    const res = await fetch(`${API_BASE}/bans`);
    const data = await res.json();
    return data.bans;
  },

  async createBan(banData) {
    const res = await fetch(`${API_BASE}/bans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(banData),
    });
    return res.json();
  },

  async unbanUser(banId) {
    const res = await fetch(`${API_BASE}/bans/${banId}`, {
      method: 'DELETE',
    });
    return res.json();
  },

  // Cosmetics
  async getCosmetics() {
    const res = await fetch(`${API_BASE}/cosmetics`);
    const data = await res.json();
    return data.cosmetics;
  },

  async createCosmetic(cosmeticData) {
    const res = await fetch(`${API_BASE}/cosmetics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cosmeticData),
    });
    return res.json();
  },

  async deleteCosmetic(id) {
    const res = await fetch(`${API_BASE}/cosmetics/${id}`, {
      method: 'DELETE',
    });
    return res.json();
  },

  // Broadcast
  async sendBroadcast(payload) {
    const res = await fetch(`${API_BASE}/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  },
};
