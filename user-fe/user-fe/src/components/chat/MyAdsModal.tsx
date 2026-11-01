'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Megaphone, Plus, Trash2, ExternalLink, Loader2, X, Clock, Eye, Sparkles } from 'lucide-react';
import * as socialApi from '@/lib/api/social';
import type { Ad } from '@/types/dm';
import AdComposerModal from './AdComposerModal';

interface MyAdsModalProps {
  onClose: () => void;
  roomId?: string;
}

/** The links written in an ad's text (shown as chips). */
function linksOf(text: string): string[] {
  return (text.match(/https?:\/\/[^\s]+|\b[a-z0-9-]+\.[a-z]{2,}(?:\/[^\s]*)?/gi) ?? []).map((l) =>
    /^https?:\/\//i.test(l) ? l : `https://${l}`,
  );
}

export default function MyAdsModal({ onClose, roomId }: MyAdsModalProps) {
  const [activeTab, setActiveTab] = useState<'feed' | 'my_ads'>('feed');
  const [feedAds, setFeedAds] = useState<Ad[]>([]);
  const [myAds, setMyAds] = useState<Ad[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [showComposer, setShowComposer] = useState(false);

  // "Separate Advertisement Tab: ON / OFF": the live feed tab shows only while the admin has it on.
  const [separateTab, setSeparateTab] = useState(true);

  const fetchAds = useCallback(async () => {
    setLoading(true);
    try {
      const options = await socialApi.getAdOptions().catch(() => null);
      const tabOn = options?.separateTab !== false;
      setSeparateTab(tabOn);
      if (!tabOn) setActiveTab('my_ads');
      const [feedRes, myRes] = await Promise.all([
        tabOn ? socialApi.getAds({ limit: 30 }).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
        socialApi.getMyAds({ limit: 30 }).catch(() => ({ items: [] })),
      ]);
      setFeedAds(feedRes.items || []);
      setMyAds(myRes.items || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAds();
  }, [fetchAds]);

  async function handleCancelAd(adId: string) {
    if (!confirm('Are you sure you want to cancel this ad? Unspent credits might not be refunded.')) return;
    setCancellingId(adId);
    try {
      await socialApi.cancelAd(adId);
      await fetchAds();
    } catch (err: any) {
      alert(err?.message || 'Failed to cancel ad');
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9998,
          background: 'rgba(0, 0, 0, 0.75)',
          backdropFilter: 'blur(6px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1rem',
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: '560px',
            background: 'var(--bg-card, #11141c)',
            border: '1px solid var(--border-color, #232734)',
            borderRadius: '14px',
            display: 'flex',
            flexDirection: 'column',
            maxHeight: '85vh',
            boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '1.25rem 1.5rem',
              borderBottom: '1px solid var(--border-color, #232734)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
              <Megaphone size={20} style={{ color: '#ec4899' }} />
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>
                Promoted Ads & Sponsorships
              </h3>
            </div>
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted, #94a3b8)',
                cursor: 'pointer',
                padding: '0.25rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '6px',
              }}
            >
              <X size={18} />
            </button>
          </div>

          {/* Action & Tabs row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: '1px solid var(--border-color, #232734)',
              padding: '0 1rem',
              background: 'rgba(0,0,0,0.15)',
            }}
          >
            <div style={{ display: 'flex' }}>
              {separateTab && (
              <button
                onClick={() => setActiveTab('feed')}
                style={{
                  padding: '0.85rem 1.25rem',
                  background: 'none',
                  border: 'none',
                  borderBottom: activeTab === 'feed' ? '2px solid #ec4899' : '2px solid transparent',
                  color: activeTab === 'feed' ? '#fff' : 'var(--text-muted, #94a3b8)',
                  fontWeight: activeTab === 'feed' ? 600 : 500,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  fontSize: '0.875rem',
                }}
              >
                <Sparkles size={16} />
                Live Feed ({feedAds.length})
              </button>
              )}
              <button
                onClick={() => setActiveTab('my_ads')}
                style={{
                  padding: '0.85rem 1.25rem',
                  background: 'none',
                  border: 'none',
                  borderBottom: activeTab === 'my_ads' ? '2px solid #ec4899' : '2px solid transparent',
                  color: activeTab === 'my_ads' ? '#fff' : 'var(--text-muted, #94a3b8)',
                  fontWeight: activeTab === 'my_ads' ? 600 : 500,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  fontSize: '0.875rem',
                }}
              >
                <Megaphone size={16} />
                My Ads ({myAds.length})
              </button>
            </div>

            <button
              onClick={() => setShowComposer(true)}
              style={{
                padding: '0.45rem 0.85rem',
                background: 'linear-gradient(135deg, #ec4899, #8b5cf6)',
                border: 'none',
                borderRadius: '7px',
                color: '#fff',
                fontWeight: 600,
                fontSize: '0.8rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
              }}
            >
              <Plus size={15} />
              Create Ad
            </button>
          </div>

          {/* List */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.25rem', minHeight: '260px' }}>
            {loading ? (
              <div
                style={{
                  padding: '3rem',
                  textAlign: 'center',
                  color: 'var(--text-muted, #94a3b8)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}
              >
                <Loader2 size={24} className="animate-spin" />
                <span style={{ fontSize: '0.85rem' }}>Loading ads...</span>
              </div>
            ) : activeTab === 'feed' ? (
              feedAds.length === 0 ? (
                <div style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--text-muted, #94a3b8)', fontSize: '0.875rem' }}>
                  No active broadcast ads right now. Be the first to promote something!
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {feedAds.map((ad) => (
                    <div
                      key={ad.id}
                      style={{
                        padding: '1rem',
                        background: 'var(--bg-input, #161922)',
                        border: '1px solid var(--border-color, #232734)',
                        borderRadius: '10px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.5rem',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontWeight: 600, fontSize: '0.85rem', color: '#fff' }}>
                            Sponsored
                          </span>
                          {ad.badge && (
                            <span
                              style={{
                                fontSize: '0.7rem',
                                padding: '0.15rem 0.45rem',
                                borderRadius: '4px',
                                background: 'rgba(236, 72, 153, 0.2)',
                                color: '#f472b6',
                                fontWeight: 600,
                              }}
                            >
                              {ad.badge.emoji ? `${ad.badge.emoji} ` : ''}{ad.badge.text || 'PROMOTED'}
                            </span>
                          )}
                        </div>
                        <span style={{ fontSize: '0.725rem', color: 'var(--text-muted, #94a3b8)' }}>
                          {new Date(ad.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>

                      <p style={{ margin: 0, fontSize: '0.875rem', color: '#e2e8f0', lineHeight: 1.45 }}>
                        {ad.content}
                      </p>

                      {linksOf(ad.content).length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.25rem' }}>
                          {linksOf(ad.content).map((link, idx) => (
                            <a
                              key={idx}
                              href={link}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.35rem',
                                fontSize: '0.775rem',
                                color: '#38bdf8',
                                textDecoration: 'none',
                                background: 'rgba(56, 189, 248, 0.1)',
                                padding: '0.2rem 0.5rem',
                                borderRadius: '4px',
                              }}
                            >
                              <ExternalLink size={12} />
                              {link.replace(/^https?:\/\//, '').slice(0, 30)}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )
            ) : myAds.length === 0 ? (
              <div style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--text-muted, #94a3b8)', fontSize: '0.875rem' }}>
                You have not created any ads yet.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {myAds.map((ad) => (
                  <div
                    key={ad.id}
                    style={{
                      padding: '1rem',
                      background: 'var(--bg-input, #161922)',
                      border: '1px solid var(--border-color, #232734)',
                      borderRadius: '10px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.5rem',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span
                          style={{
                            fontSize: '0.7rem',
                            fontWeight: 700,
                            padding: '0.2rem 0.5rem',
                            borderRadius: '4px',
                            background: ad.status === 'ACTIVE' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(148, 163, 184, 0.15)',
                            color: ad.status === 'ACTIVE' ? '#4ade80' : '#94a3b8',
                          }}
                        >
                          {ad.status}
                        </span>
                        {ad.badge && (
                          <span style={{ fontSize: '0.75rem', color: '#f472b6' }}>
                            {ad.badge.emoji ? `${ad.badge.emoji} ` : ''}{ad.badge.text || ''}
                          </span>
                        )}
                      </div>

                      {(ad.status === 'ACTIVE' || ad.status === 'PAUSED') && (
                        <button
                          onClick={() => handleCancelAd(ad.id)}
                          disabled={cancellingId === ad.id}
                          style={{
                            background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid rgba(239, 68, 68, 0.3)',
                            borderRadius: '5px',
                            color: '#ef4444',
                            fontSize: '0.75rem',
                            padding: '0.25rem 0.6rem',
                            cursor: cancellingId === ad.id ? 'not-allowed' : 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.3rem',
                          }}
                        >
                          {cancellingId === ad.id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Trash2 size={12} />
                          )}
                          Cancel Ad
                        </button>
                      )}
                    </div>

                    <p style={{ margin: 0, fontSize: '0.875rem', color: '#e2e8f0' }}>{ad.content}</p>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', fontSize: '0.75rem', color: 'var(--text-muted, #94a3b8)', marginTop: '0.25rem' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                        <Clock size={12} /> {new Date(ad.createdAt).toLocaleDateString()}
                      </span>
                      <span>
                        Posts {ad.postedCount}/{ad.repeatCount + 1}
                        {ad.pinMinutes ? ` · pinned ${ad.pinMinutes} min` : ''}
                      </span>
                      {ad.priceUsd != null && <span>Paid: ${ad.priceUsd}</span>}
                      {ad.refundUsd && <span style={{ color: '#4ade80' }}>Refund: ${ad.refundUsd}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showComposer && (
        <AdComposerModal
          roomId={roomId}
          onClose={() => setShowComposer(false)}
          onDone={() => {
            setShowComposer(false);
            fetchAds();
          }}
        />
      )}
    </>
  );
}
