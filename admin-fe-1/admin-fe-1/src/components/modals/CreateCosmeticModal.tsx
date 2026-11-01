import React, { useState } from 'react';

interface CreateCosmeticModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (data: {
    name: string;
    description: string;
    gradient: string;
    borderColor: string;
    badgeIcon: string;
    cost: number;
    isPremium: boolean;
  }) => void;
}

export const CreateCosmeticModal: React.FC<CreateCosmeticModalProps> = ({
  isOpen,
  onClose,
  onCreate,
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [gradient, setGradient] = useState('linear-gradient(135deg, #00f2fe 0%, #4facfe 100%)');
  const [borderColor, setBorderColor] = useState('#00f2fe');
  const [badgeIcon, setBadgeIcon] = useState('VIP');
  const [cost, setCost] = useState(5);
  const [isPremium, setIsPremium] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onCreate({
      name: name.trim(),
      description: description.trim(),
      gradient,
      borderColor,
      badgeIcon,
      cost,
      isPremium,
    });
    setName('');
    setDescription('');
  };

  return (
    <div className="modal-overlay">
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>Create New Chat Skin</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label>Skin Name</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. Neon Cyberpunk"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label>CSS Background Gradient</label>
              <input
                type="text"
                className="form-control"
                value={gradient}
                onChange={(e) => setGradient(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label>Border Hex Color</label>
              <input
                type="text"
                className="form-control"
                value={borderColor}
                onChange={(e) => setBorderColor(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label>Badge Icon</label>
              <input
                type="text"
                className="form-control"
                value={badgeIcon}
                onChange={(e) => setBadgeIcon(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label>Price in USD (0 for free/included)</label>
              <input
                type="number"
                step="0.5"
                className="form-control"
                value={cost}
                onChange={(e) => setCost(Number(e.target.value))}
              />
            </div>
            <div className="form-group">
              <label>Description</label>
              <input
                type="text"
                className="form-control"
                placeholder="Short description of skin appearance"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                id="react-cosm-prem"
                type="checkbox"
                checked={isPremium}
                onChange={(e) => setIsPremium(e.target.checked)}
              />
              <label htmlFor="react-cosm-prem" style={{ fontSize: '13px', fontWeight: 500 }}>
                Premium / VIP Exclusive (Requires membership)
              </label>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-action">
              Publish Skin
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
