import { Injectable, Logger } from '@nestjs/common';

// What changed, told to whoever holds live state (the gateway, the caches).
// Every source of change publishes here — the admin-to-chat signal (chat.events.listener.ts), staff actions
// in this app, and scheduled settings changes — so "a change reaches open connections" is written once.
// One process, one server: this is an in-memory fan-out, not a message broker.
export type ChatChange =
  // Chat-wide settings changed.
  | { readonly kind: 'settings' }
  // A room's config, rule, status, excluded users or existence changed.
  | { readonly kind: 'room'; readonly roomId: string }
  // A user's role or eligibility facts may have changed.
  | { readonly kind: 'user'; readonly userId: string }
  // A user saved preferences; their open sockets take the new values without a read per send.
  | {
      readonly kind: 'preferences';
      readonly userId: string;
      readonly hideIdentity: boolean;
      readonly activeSkinId: string | null;
    }
  // A ban or unban for a user.
  | { readonly kind: 'ban'; readonly userId: string }
  // Alert messages to deliver (admin broadcast or system alert).
  | { readonly kind: 'alert'; readonly messageIds: readonly string[] }
  // A message was retracted outside this app (admin).
  | {
      readonly kind: 'retract';
      readonly messageId: string;
      readonly roomId: string;
      readonly retractedAt: string;
    }
  // A message was pinned or unpinned.
  | {
      readonly kind: 'pin';
      readonly messageId: string;
      readonly roomId: string;
      readonly pinned: boolean;
    }
  // Chat-wide or room restrictions changed (Module 4): reload the restriction cache.
  | { readonly kind: 'restrictions' }
  // RainPool settings changed (admin panel or staff): clients reload the rain state.
  | { readonly kind: 'rain' }
  // An admin asked a user for the questionnaire or a KYC check on a rain under manual review.
  | { readonly kind: 'rain_request'; readonly userId: string; readonly rainId: string }
  // A user's mute or block list changed (Module 5).
  | { readonly kind: 'relations'; readonly userId: string }
  // An ad was created, cancelled, paused or resumed (Module 5): re-check pinned slots and repeats.
  | { readonly kind: 'ad'; readonly adId: string }
  // An admin removed a DM or group message from members' view (Module 8).
  | { readonly kind: 'dm_hidden'; readonly conversationId: string; readonly messageId: string }
  // A follow was added or removed between two people. The Social module publishes this (the chat server does not own
// follows): their direct chat is placed again by the folder rules.
  | { readonly kind: 'follow'; readonly userA: string; readonly userB: string }
  // A staff request (REPORT mode) was made or resolved (Module 4).
  | { readonly kind: 'staff_request'; readonly requestId: string }
  // A support ticket got an answer or was closed (Module 10): tell its owner.
  | {
      readonly kind: 'support';
      readonly userId: string;
      readonly ticketId: string;
      readonly status: string;
    }
  // A moderation note for the affected user only.
  | {
      readonly kind: 'notice';
      readonly userId: string;
      readonly notice: {
        readonly action: string;
        readonly roomId?: string | null;
        readonly messageId?: string | null;
        readonly note: string | null;
        readonly expiresAt?: string | null;
      };
    };

type Listener = (change: ChatChange) => void | Promise<void>;

@Injectable()
export class ChatBus {
  private readonly logger = new Logger('ChatBus');
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(change: ChatChange): void {
    for (const listener of this.listeners) {
      try {
        const result = listener(change);
        if (result instanceof Promise) {
          result.catch((err: unknown) =>
            this.logger.error({ err, kind: change.kind }, 'chat change listener failed'),
          );
        }
      } catch (err: unknown) {
        this.logger.error({ err, kind: change.kind }, 'chat change listener failed');
      }
    }
  }
}
