import React from 'react';
import { ChatCosmetic } from '../../types';
import { IconPlus, IconSparkles } from '../Icons';

interface CosmeticsViewProps {
  cosmetics: ChatCosmetic[];
  onOpenCreateCosmetic: () => void;
  onDeleteCosmetic: (id: string) => void;
  onActivateCosmetic: (id: string) => void;
}

export const CosmeticsView: React.FC<CosmeticsViewProps> = ({
  cosmetics,
  onOpenCreateCosmetic,
  onDeleteCosmetic,
  onActivateCosmetic,
}) => {
  return (
    <section className="tab-view">
      <div className="card-section">
        <div className="card-header-row">
          <div>
            <h3>Chat Skins &amp; Cosmetics Studio (FSD 3.1.11)</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Manage custom message bubbles, gradient borders, VIP badges, and pricing for users.
            </p>
          </div>
          <button className="btn-action" onClick={onOpenCreateCosmetic}>
            <IconPlus size={15} />
            <span>Create Chat Skin</span>
          </button>
        </div>

        <div className="cosmetics-grid">
          {cosmetics.map((c) => (
            <div key={c.id} className="cosmetic-card">
              <div
                className="cosmetic-preview-bubble"
                style={{ background: c.gradient, border: `1.5px solid ${c.borderColor}` }}
              >
                <div className="bubble-sender" style={{ color: '#fff' }}>
                  <IconSparkles size={14} color="#ffd700" />
                  <span>SampleUser</span>
                  <span style={{ fontSize: '10px', background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                    VIP
                  </span>
                </div>
                <p style={{ color: '#fff', fontWeight: 500 }}>
                  This is how messages with the {c.name} skin look in live chat!
                </p>
              </div>

              <div className="cosmetic-info">
                <div className="cosmetic-title-row">
                  <h4>{c.name}</h4>
                  <span className="cosmetic-price">{Number(c.cost) > 0 ? `$${Number(c.cost).toFixed(2)}` : 'FREE'}</span>
                </div>
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{c.description}</p>
                <div style={{ display: 'flex', gap: '8px', marginTop: '10px', alignItems: 'center' }}>
                  <span className={`tag-badge ${c.isPremium ? 'tag-vip' : 'tag-global'}`}>
                    {c.isPremium ? 'Premium Exclusive' : 'Public Store'}
                  </span>
                  {(c as any).isActive === false ? (
                    <button
                      className="btn-action"
                      style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: '11px' }}
                      onClick={() => onActivateCosmetic(c.id)}
                      title="Make this skin selectable again (CH-074)"
                    >
                      Activate
                    </button>
                  ) : (
                    <button
                      className="btn-danger"
                      style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: '11px' }}
                      onClick={() => onDeleteCosmetic(c.id)}
                    >
                      Deactivate
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};
