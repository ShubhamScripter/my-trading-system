import React, { useState, useEffect } from 'react';
import { AdminRoom } from '../../types';
import { AdminAPI } from '../../services/api';
import { IconPlus, IconCheck } from '../Icons';

interface RulesViewProps {
  rooms: AdminRoom[];
  selectedRoomId: string;
  onRoomSelect: (roomId: string) => void;
  onShowToast: (msg: string, type?: 'success' | 'danger') => void;
}

export const RulesView: React.FC<RulesViewProps> = ({
  rooms,
  selectedRoomId,
  onRoomSelect,
  onShowToast,
}) => {
  const [currentRules, setCurrentRules] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (selectedRoomId) {
      loadRules(selectedRoomId);
    } else if (rooms.length > 0) {
      onRoomSelect(rooms[0]!.id);
    }
  }, [selectedRoomId, rooms]);

  const loadRules = async (roomId: string) => {
    setLoading(true);
    try {
      const data = await AdminAPI.getRules(roomId);
      setCurrentRules(data.rules || []);
    } catch {
      onShowToast('Failed to load room rules', 'danger');
    } finally {
      setLoading(false);
    }
  };

  const handleRuleChange = (index: number, val: string) => {
    const updated = [...currentRules];
    updated[index] = val;
    setCurrentRules(updated);
  };

  const handleRemoveRule = (index: number) => {
    setCurrentRules(currentRules.filter((_, i) => i !== index));
  };

  const handleAddRule = () => {
    setCurrentRules([...currentRules, '']);
  };

  const handleSave = async () => {
    const filtered = currentRules.map((r) => r.trim()).filter(Boolean);
    try {
      const res = await AdminAPI.updateRules(selectedRoomId, filtered);
      if (res.success) {
        onShowToast('Room rules saved successfully!');
      } else {
        onShowToast('Failed to save rules', 'danger');
      }
    } catch {
      onShowToast('Network error saving rules', 'danger');
    }
  };

  return (
    <section className="tab-view">
      <div className="card-section">
        <div className="card-header-row">
          <div>
            <h3>Chat Rules Box Editor (FSD 3.1.9)</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Set visible community guidelines displayed to users when they open the Chat Rules Box in each room.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Select Room:</label>
            <select
              className="form-control"
              style={{ minWidth: '220px' }}
              value={selectedRoomId}
              onChange={(e) => onRoomSelect(e.target.value)}
            >
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.type})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ marginTop: '14px' }}>
          {loading ? (
            <p style={{ color: 'var(--text-muted)' }}>Loading rules...</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {currentRules.map((rule, idx) => (
                <div key={idx} style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--primary)', fontWeight: 700, width: '24px' }}>#{idx + 1}</span>
                  <input
                    type="text"
                    className="form-control"
                    style={{ flex: 1 }}
                    value={rule}
                    placeholder="Enter community rule..."
                    onChange={(e) => handleRuleChange(idx, e.target.value)}
                  />
                  <button
                    className="btn-danger"
                    style={{ padding: '8px 12px' }}
                    onClick={() => handleRemoveRule(idx)}
                    title="Remove rule"
                  >
                    &times;
                  </button>
                </div>
              ))}

              <div style={{ marginTop: '16px', display: 'flex', gap: '12px' }}>
                <button
                  className="btn-secondary"
                  onClick={handleAddRule}
                  style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <IconPlus size={14} />
                  <span>Add Another Rule</span>
                </button>
                <button
                  className="btn-action"
                  onClick={handleSave}
                  style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <IconCheck size={14} />
                  <span>Save Rules for Room</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
