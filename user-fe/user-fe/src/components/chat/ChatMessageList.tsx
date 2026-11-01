'use client';

import React from 'react';
import { Lock, Hash, Sparkles, Ghost, Undo2, Flag, Pin, PinOff } from 'lucide-react';
import type { CosmeticItem, Message, RoomItem, User } from '@/types/chat';
import styles from './ChatMessageList.module.css';

/** 3.1.11: renders the sender's *actual* equipped cosmetic (gradient, border,
 *  glow, badge) from its stored style config, rather than guessing from the
 *  cosmetic's id — which only ever worked for the five hardcoded demo skins
 *  and silently no-opped for anything created in the admin Skins Studio.
 *
 *  Two producers disagree on key names for the same JSON blob: the seed data
 *  writes `{ border, badge }`, the admin Skins Studio writes `{ borderColor,
 *  badgeIcon }`. Both are accepted here rather than picking one, since fixing
 *  the mismatch at its source would mean migrating already-seeded rows. */
function cosmeticFor(
  cosmeticId: string | null | undefined,
  cosmetics: CosmeticItem[],
): { bubbleStyle: React.CSSProperties; textColor?: string; badge: React.ReactNode } {
  if (!cosmeticId) return { bubbleStyle: {}, badge: null };

  const cosmetic = cosmetics.find((c) => c.id === cosmeticId);
  const style = cosmetic?.style as
    | {
        gradient?: string;
        border?: string;
        borderColor?: string;
        glowColor?: string;
        textColor?: string;
        badge?: string;
        badgeIcon?: string;
      }
    | undefined;

  if (!style) return { bubbleStyle: {}, badge: null };

  const borderColor = style.borderColor;
  const badgeText = style.badge || style.badgeIcon;

  const bubbleStyle: React.CSSProperties = {};
  if (style.gradient) bubbleStyle.background = style.gradient;
  if (style.border) {
    bubbleStyle.border = style.border;
  } else if (borderColor) {
    bubbleStyle.borderColor = borderColor;
  }
  if (style.glowColor) bubbleStyle.boxShadow = `0 0 12px ${style.glowColor}`;

  return {
    bubbleStyle,
    textColor: style.textColor,
    badge: badgeText ? (
      <span className="cosmetic-tag-pill" style={{ color: style.textColor, borderColor }}>
        <Sparkles size={10} /> {badgeText}
      </span>
    ) : null,
  };
}

interface ChatMessageListProps {
  messages: Message[];
  activeRoom: RoomItem | null | undefined;
  token: string | null;
  currentUser: User | null;
  cosmetics: CosmeticItem[];
  feedEndRef: React.RefObject<HTMLDivElement | null>;
  onMentionAuthor: (username: string) => void;
  onRetractMessage: (messageId: string) => void;
  onReportMessage: (message: Message) => void;
  /** Module 4 staff permissions of the viewer (ACT or REPORT), from GET /social/chat/staff/permissions. */
  staff?: { canPin: boolean; canDelete: boolean; seeDeleted: boolean };
  onTogglePin?: (message: Message) => void;
}

export default function ChatMessageList({
  messages,
  activeRoom,
  token,
  currentUser,
  cosmetics,
  feedEndRef,
  onMentionAuthor,
  onRetractMessage,
  onReportMessage,
  staff,
  onTogglePin,
}: ChatMessageListProps) {
  if (activeRoom?.accessMode === 'LOCKED' && !activeRoom.isEligibleToView) {
    return (
      <div className={`message-feed ${styles.feedScroll}`}>
        <div className="empty-feed" style={{ color: '#f87171' }}>
          <Lock size={36} />
          <p style={{ fontWeight: 600, color: '#fca5a5' }}>Room Locked by Administrator</p>
          <small style={{ color: '#94a3b8', maxWidth: '400px', textAlign: 'center' }}>
            {activeRoom.reason || 'Merchant, Site Owner, or specific role authorization required to enter.'}
          </small>
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className={`message-feed ${styles.feedScroll}`}>
        <div className="empty-feed">
          <Hash size={32} />
          <p>{token ? 'No messages in this room yet.' : 'Please log in to load messages.'}</p>
          <small>{token ? 'Be the first to post below!' : 'Authentication is required for messaging.'}</small>
        </div>
      </div>
    );
  }

  return (
    <div className={`message-feed ${styles.feedScroll}`}>
      {messages.map((msg) => {
        if (msg.type === 'SYSTEM_ALERT' || msg.type === 'ADMIN_ALERT') {
          return (
            <div key={msg.id} className="system-alert-card">
              <div className="system-alert-badge">
                <Sparkles size={13} />
                <span>{msg.type === 'ADMIN_ALERT' ? 'ANNOUNCEMENT' : 'PLATFORM ALERT'}</span>
                {msg.type === 'SYSTEM_ALERT' && (
                  <span style={{ marginLeft: '0.4rem', opacity: 0.8 }}>· @{msg.bot?.username ?? msg.username}</span>
                )}
              </div>
              <p className="system-alert-content">{msg.content}</p>
              <span className="msg-time">{new Date(msg.createdAt).toLocaleTimeString()}</span>
            </div>
          );
        }

        // An ad (Module 5): never hidden by mute or block; shown with its badge and paid skin.
        if (msg.type === 'AD') {
          const style = msg.skin?.style ?? {};
          return (
            <div
              key={msg.id}
              className="system-alert-card"
              style={{
                borderColor: style.border ?? style.color ?? 'rgba(236,72,153,0.45)',
                background: style.background ?? 'rgba(236,72,153,0.06)',
              }}
            >
              <div className="system-alert-badge" style={{ color: style.color ?? '#f472b6' }}>
                <span>
                  {msg.ad?.badge?.emoji ? `${msg.ad.badge.emoji} ` : '📣 '}
                  {msg.ad?.badge?.text ?? 'SPONSORED'}
                </span>
                <span style={{ marginLeft: '0.4rem', opacity: 0.8 }}>· @{msg.username}</span>
              </div>
              <p className="system-alert-content">{msg.content}</p>
              <span className="msg-time">{new Date(msg.createdAt).toLocaleTimeString()}</span>
            </div>
          );
        }

        // A gift (Module 5): "/send" or "/gift" from this room.
        if (msg.type === 'GIFT' && msg.gift) {
          return (
            <div key={msg.id} className="system-alert-card" style={{ borderColor: 'rgba(251,191,36,0.45)' }}>
              <div className="system-alert-badge" style={{ color: '#fbbf24' }}>
                <span>🎁 GIFT</span>
              </div>
              <p className="system-alert-content">
                @{msg.username} sent{' '}
                <strong style={{ color: '#fbbf24' }}>
                  {msg.gift.amount} {msg.gift.currency}
                </strong>
                {msg.gift.recipientUsername ? ` to @${msg.gift.recipientUsername}` : ''}
              </p>
              <span className="msg-time">{new Date(msg.createdAt).toLocaleTimeString()}</span>
            </div>
          );
        }

        // History and broadcasts send `isRetracted`; the live retract event sets `retractedAt` (CH-003).
        const isRetracted = Boolean(msg.isRetracted || msg.retractedAt);
        // Staff "Delete Messages from chat" (the server checks the role's permission and rank).
        const isStaff = Boolean(currentUser?.staffRole) && (staff?.canDelete ?? false);
        // "Retracted … visible to mods / team with retracted tag": the server sends the content to staff who may see it.
        const showRetractedContent = isRetracted && Boolean(staff?.seeDeleted) && Boolean(msg.content || msg.media);
        // The client never learns its own internal user id (auth responses only
        // ever carry `publicCode`, by design — see auth/dto/response.dto.ts) so
        // `currentUser.id` is always undefined here. `username` is the one
        // identifier both the session and every broadcast message actually
        // carry, and is exactly what the sender's own client can recognize.
        const isAuthor = Boolean(currentUser?.username) && currentUser!.username === msg.username;
        const canRetract = (isAuthor || isStaff) && !isRetracted;
        // The server sends media as `msg.media` (CH-008); metadata.* is the older shape.
        const mediaUrl = msg.media?.url ?? msg.metadata?.mediaUrl;
        const mediaType = msg.media?.type ?? msg.metadata?.mediaType;
        const thumbnailUrl = msg.media?.thumbnailUrl ?? msg.metadata?.thumbnailUrl;
        const isAnonymousMsg = Boolean(msg.metadata?.isAnonymous || msg.metadata?.hideIdentity || msg.username === 'Anonymous');
        const cosmetic = cosmeticFor(msg.skinId || msg.cosmeticId, cosmetics);

        return (
          <div
            key={msg.id}
            className={`message-bubble ${isRetracted ? 'retracted' : ''}`}
            style={cosmetic.bubbleStyle}
          >
            <div className="message-header">
              <div className="flex-center gap-2">
                <span
                  className={`msg-author ${isAnonymousMsg ? 'text-cyan' : ''}`}
                  style={!isAnonymousMsg && cosmetic.textColor ? { color: cosmetic.textColor } : undefined}
                  onClick={() => msg.username && !isAnonymousMsg && onMentionAuthor(msg.username)}
                >
                  {!msg.username ? (
                    // A retracted message reaches others without its author (CH-003).
                    <span>Retracted message</span>
                  ) : isAnonymousMsg ? (
                    <span className="flex-center gap-1" style={{ display: 'inline-flex' }}>
                      <Ghost size={12} /> Anonymous
                    </span>
                  ) : (
                    `@${msg.username}`
                  )}{' '}
                  {isAuthor && '(You)'}
                </span>
                {cosmetic.badge}
              </div>
              <div className="flex-center gap-2">
                {isRetracted && (
                  <span className="badge-retracted flex-center gap-1">
                    <Undo2 size={10} />
                    Retracted
                  </span>
                )}
                <span className="msg-time">{new Date(msg.createdAt).toLocaleTimeString()}</span>

                {msg.isPinned && !isRetracted && (
                  <span title="Pinned by staff" style={{ display: 'inline-flex', color: '#facc15' }}>
                    <Pin size={11} />
                  </span>
                )}

                <div className="msg-action-tray">
                  {staff?.canPin && onTogglePin && !isRetracted && (
                    <button
                      type="button"
                      onClick={() => onTogglePin(msg)}
                      className="btn-icon-xs"
                      style={{ color: '#facc15' }}
                      title={msg.isPinned ? 'Unpin message' : 'Pin message'}
                    >
                      {msg.isPinned ? <PinOff size={12} /> : <Pin size={12} />}
                    </button>
                  )}
                  {canRetract && (
                    <button
                      type="button"
                      onClick={() => onRetractMessage(msg.id)}
                      className="btn-icon-xs text-red"
                      title="Retract / Delete message"
                    >
                      <Undo2 size={12} />
                    </button>
                  )}
                  {!isAuthor && !isRetracted && (
                    <button
                      type="button"
                      onClick={() => onReportMessage(msg)}
                      className="btn-icon-xs text-amber"
                      title="Report inappropriate content"
                    >
                      <Flag size={12} />
                    </button>
                  )}
                </div>
              </div>
            </div>

            {showRetractedContent ? (
              <div className="msg-body-wrapper" style={{ opacity: 0.7 }}>
                <small style={{ color: '#f87171', fontSize: '0.68rem', fontWeight: 600 }}>
                  Retracted · visible to staff only
                </small>
                {msg.content && <p className="message-text" style={{ textDecoration: 'line-through' }}>{msg.content}</p>}
                {mediaUrl && <img src={mediaUrl} alt="Retracted attachment" className="chat-image-preview" loading="lazy" />}
              </div>
            ) : isRetracted ? (
              <div className="retracted-content">
                <span className="text-slate-400 italic flex-center gap-1" style={{ color: '#94a3b8', fontStyle: 'italic', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <Undo2 size={12} /> [This message was retracted]
                </span>
              </div>
            ) : (
              <div className="msg-body-wrapper">
                {msg.content && <p className="message-text">{msg.content}</p>}

                {mediaUrl && (
                  <div className="message-media-attachment">
                    {mediaType === 'video' ? (
                      <video controls src={mediaUrl} className="chat-video-preview" poster={thumbnailUrl} />
                    ) : (
                      <img
                        src={mediaUrl}
                        alt={msg.metadata?.caption || 'Attached image'}
                        className="chat-image-preview"
                        loading="lazy"
                        onClick={() => window.open(mediaUrl, '_blank')}
                      />
                    )}
                    {msg.metadata?.caption && <p className="media-caption">{msg.metadata.caption}</p>}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div ref={feedEndRef} />
    </div>
  );
}
