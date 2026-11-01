'use client';

/**
 * What a chat command answered (Module 5), shown only to the user who typed it, above the composer: /help lists the
 * commands usable in this room, /mutelist and /blocklist the people, /mute … /unblock and /ad a confirmation.
 * /dm and /send open the DM panel and the gift form instead (page.tsx).
 */
import React from 'react';
import { Terminal, X } from 'lucide-react';

export interface CommandOutput {
  title: string;
  lines: string[];
  /** People in a /mutelist or /blocklist, each with an undo button. */
  people?: { username: string; undoLabel: string; onUndo: () => void }[];
}

/* eslint-disable @typescript-eslint/no-explicit-any -- command results differ per command */
export function describeCommand(
  command: string,
  result: any,
  undo: (list: 'mutes' | 'blocks', username: string) => void,
): CommandOutput | null {
  switch (command) {
    case 'help':
      return {
        title: 'Commands you can use here',
        lines: (result?.commands ?? []).map((c: { usage: string }) => c.usage),
      };
    case 'mute':
    case 'unmute':
    case 'block':
    case 'unblock': {
      const who = `@${result?.username ?? 'user'}`;
      const done =
        command === 'mute'
          ? `${who} is muted: you won't see their messages in public chat`
          : command === 'unmute'
            ? `${who} is unmuted`
            : command === 'block'
              ? `${who} is blocked: you won't see their messages and neither of you can DM the other`
              : `${who} is unblocked`;
      return { title: `/${command}`, lines: [result?.changed === false ? `${done} (no change)` : done] };
    }
    case 'mutelist':
    case 'blocklist': {
      const list = command === 'mutelist' ? 'mutes' : 'blocks';
      const items: { username: string }[] = result?.items ?? [];
      return {
        title: command === 'mutelist' ? 'Muted users' : 'Blocked users',
        lines: items.length === 0 ? [command === 'mutelist' ? 'You have not muted anyone.' : 'You have not blocked anyone.'] : [],
        people: items.map((p) => ({
          username: p.username,
          undoLabel: list === 'mutes' ? 'Unmute' : 'Unblock',
          onUndo: () => undo(list, p.username),
        })),
      };
    }
    case 'rain':
      return {
        title: 'Rain',
        lines: [
          `${result?.pot ?? ''} ${result?.currency ?? ''}${result?.usd ? ` (~${result.usd} USD)` : ''} across ${result?.recipients ?? 0} people`,
          ...(result?.fee && result.fee !== '0' ? [`Fee ${result.fee} ${result?.currency ?? ''}`] : []),
          result?.status === 'COMPLETED'
            ? 'Paid and posted in this room.'
            : result?.status === 'PENDING_REVIEW'
              ? 'Waiting for an admin to approve it. Nothing has been taken from your balance yet.'
              : result?.status === 'PENDING_VERIFICATION'
                ? 'Waiting for your confirmation.'
                : String(result?.status ?? ''),
        ],
      };
    case 'ad':
      return {
        title: 'Ad posted',
        lines: [
          `Ad ${String(result?.adId ?? '').slice(0, 8)} is ${String(result?.status ?? 'ACTIVE').toLowerCase()}`,
          ...(result?.price?.totalUsd !== undefined ? [`Charged ${result.price.totalUsd} USD`] : []),
          'Manage it under Ads → My Ads.',
        ],
      };
    default:
      return null;
  }
}

export default function CommandResultCard({ output, onClose }: { output: CommandOutput; onClose: () => void }) {
  return (
    <div
      role="status"
      style={{
        margin: '0 0 0.5rem',
        padding: '0.6rem 0.75rem',
        borderRadius: '10px',
        background: 'rgba(99,102,241,0.08)',
        border: '1px solid rgba(99,102,241,0.3)',
        fontSize: '0.8rem',
        color: '#c7d2fe',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontWeight: 700 }}>
          <Terminal size={13} /> {output.title}
        </span>
        <button type="button" onClick={onClose} className="btn-icon-xs" aria-label="Dismiss" style={{ color: '#94a3b8' }}>
          <X size={12} />
        </button>
      </div>
      {output.lines.map((line, i) => (
        <div key={i} style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem', color: '#e2e8f0', padding: '1px 0' }}>
          {line}
        </div>
      ))}
      {output.people?.map((p) => (
        <div key={p.username} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 0' }}>
          <span>@{p.username}</span>
          <button type="button" className="btn btn-sm btn-outline" style={{ padding: '1px 8px', fontSize: '0.7rem' }} onClick={p.onUndo}>
            {p.undoLabel}
          </button>
        </div>
      ))}
    </div>
  );
}
