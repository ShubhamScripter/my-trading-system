/**
 * Parsing chat commands typed in public chat (Module 5, Chat MAIN "Commands"). Pure: what a command is and what its
 * arguments say; whether it is allowed and what it does is ChatCommandsService's job.
 *
 *   /help
 *   /dm @user message…            (/pm is the same)
 *   /mute @user   /unmute @user   /mutelist
 *   /block @user  /unblock @user  /blocklist
 *   /send @user 10 USDT           (/gift is the same; "USDT 10" works too)
 *   /ad [rooms=global,es|all] [pin=10] [repeat=3x15] [badge=love] [skin=gold] [hide=IN,US] text…
 *   /rain BTC 0.01 5              (recipients: a number, "all" or "10%"; optional: repeat COUNT GAP, GAP 60 / 60s / 5m / 1h)
 */
import type { RecipientRule } from '../../rain/rain.math';
import { CHAT_COMMANDS, type ChatCommand } from '../chat.contract';

export const COMMAND_ALIASES: Readonly<Record<string, ChatCommand>> = {
  pm: 'dm',
  gift: 'send',
};

/** What /help says about each command. */
export const COMMAND_HELP: Readonly<Record<ChatCommand, string>> = {
  help: '/help — the commands you can use here',
  dm: '/dm @user message — send a direct message (/pm works too)',
  mute: "/mute @user — stop seeing someone's messages in public chat",
  unmute: '/unmute @user — see their messages again',
  mutelist: '/mutelist — who you muted',
  block: '/block @user — hide their messages; neither of you can DM the other',
  unblock: '/unblock @user — remove the block',
  blocklist: '/blocklist — who you blocked',
  send: '/send @user amount CURRENCY — send money (/gift works too)',
  ad: '/ad [rooms=a,b|all] [pin=minutes] [repeat=countxgap] [badge=id] [skin=id] [hide=IN,US] text — post an ad',
  rain: '/rain CURRENCY AMOUNT USERS|all|x% [repeat COUNT GAP(s/m/h)] — split a pot across people online here',
};

export type ParsedCommand =
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown'; readonly name: string }
  | {
      readonly kind: 'invalid';
      readonly name: ChatCommand;
      readonly message: string;
    }
  | { readonly kind: 'help' }
  | { readonly kind: 'dm'; readonly target: string; readonly text: string }
  | {
      readonly kind: 'mute' | 'unmute' | 'block' | 'unblock';
      readonly target: string;
    }
  | { readonly kind: 'mutelist' | 'blocklist' }
  | {
      readonly kind: 'send';
      readonly target: string;
      readonly amount: string;
      readonly currency: string;
    }
  | {
      readonly kind: 'ad';
      readonly text: string;
      readonly roomIds: string[];
      readonly allRooms: boolean;
      readonly pinMinutes?: number;
      readonly repeatCount?: number;
      readonly repeatGapMinutes?: number;
      readonly badgeId?: string;
      readonly skinId?: string;
      readonly hiddenCountries: string[];
    }
  | {
      readonly kind: 'rain';
      readonly currency: string;
      readonly pot: string;
      /** "Number of users to Rain: Specific Number / All Active users / x% of active users". */
      readonly recipients: RecipientRule;
      readonly repeatCount: number | null;
      readonly repeatGapSeconds: number | null;
    };

const COMMAND = /^\/([a-z]+)(?=\s|$)/i;
const HANDLE = /^@?([A-Za-z0-9_.-]{1,64})$/;
const AMOUNT = /^\d{1,18}(\.\d{1,18})?$/;
const CURRENCY = /^[A-Za-z0-9]{2,12}$/;

/** The canonical command name of `/word`, or null when the text is not a command at all. */
export function commandName(text: string): string | null {
  const match = COMMAND.exec(text.trimStart());
  if (!match) return null;
  const word = match[1]!.toLowerCase();
  return COMMAND_ALIASES[word] ?? word;
}

export function isCommand(name: string): name is ChatCommand {
  return (CHAT_COMMANDS as readonly string[]).includes(name);
}

export function parseCommand(input: string): ParsedCommand {
  const text = input.trim();
  const name = commandName(text);
  if (name === null) return { kind: 'none' };
  if (!isCommand(name)) return { kind: 'unknown', name };
  const rest = text.replace(COMMAND, '').trim();
  const words = rest.length > 0 ? rest.split(/\s+/) : [];
  const invalid = (message: string): ParsedCommand => ({
    kind: 'invalid',
    name,
    message,
  });
  const handle = (word: string | undefined): string | null => {
    const match = word ? HANDLE.exec(word) : null;
    return match ? match[1]! : null;
  };

  switch (name) {
    case 'help':
      return { kind: 'help' };
    case 'mutelist':
    case 'blocklist':
      return { kind: name };
    case 'mute':
    case 'unmute':
    case 'block':
    case 'unblock': {
      const target = handle(words[0]);
      if (!target || words.length !== 1) return invalid(`Usage: /${name} @user`);
      return { kind: name, target };
    }
    case 'dm': {
      const target = handle(words[0]);
      const body = rest.slice((words[0] ?? '').length).trim();
      if (!target || body.length === 0) return invalid('Usage: /dm @user message');
      return { kind: 'dm', target, text: body };
    }
    case 'send': {
      const target = handle(words[0]);
      if (!target || words.length !== 3) return invalid('Usage: /send @user amount CURRENCY');
      const [a, b] = [words[1]!, words[2]!];
      const [amount, currency] = AMOUNT.test(a) ? [a, b] : AMOUNT.test(b) ? [b, a] : [null, null];
      if (!amount || !currency || !CURRENCY.test(currency))
        return invalid('Usage: /send @user amount CURRENCY');
      return { kind: 'send', target, amount, currency: currency.toUpperCase() };
    }
    case 'ad': {
      const options: Record<string, string> = {};
      let index = 0;
      while (index < words.length && /^[a-z]+=\S+$/i.test(words[index]!)) {
        const [key, value] = words[index]!.split('=') as [string, string];
        options[key.toLowerCase()] = value;
        index += 1;
      }
      const body = words.slice(index).join(' ').trim();
      if (body.length === 0)
        return invalid('Usage: /ad [rooms=a,b|all] [pin=minutes] [repeat=countxgap] text');
      const known = ['rooms', 'pin', 'repeat', 'badge', 'skin', 'hide'];
      const unknownKey = Object.keys(options).find((key) => !known.includes(key));
      if (unknownKey) return invalid(`Unknown /ad option ${unknownKey}`);
      const rooms = options.rooms ?? '';
      const allRooms = rooms.toLowerCase() === 'all';
      let pinMinutes: number | undefined;
      if (options.pin !== undefined) {
        if (!/^\d{1,5}$/.test(options.pin)) return invalid('pin=minutes, a whole number');
        pinMinutes = Number(options.pin);
      }
      let repeatCount: number | undefined;
      let repeatGapMinutes: number | undefined;
      if (options.repeat !== undefined) {
        const match = /^(\d{1,3})(?:x(\d{1,5}))?$/i.exec(options.repeat);
        if (!match) return invalid('repeat=count or repeat=countxgapMinutes, e.g. repeat=3x15');
        repeatCount = Number(match[1]);
        if (match[2]) repeatGapMinutes = Number(match[2]);
      }
      return {
        kind: 'ad',
        text: body,
        roomIds: allRooms || rooms === '' ? [] : rooms.split(',').filter((r) => r.length > 0),
        allRooms,
        ...(pinMinutes !== undefined ? { pinMinutes } : {}),
        ...(repeatCount !== undefined ? { repeatCount } : {}),
        ...(repeatGapMinutes !== undefined ? { repeatGapMinutes } : {}),
        ...(options.badge ? { badgeId: options.badge.toLowerCase() } : {}),
        ...(options.skin ? { skinId: options.skin.toLowerCase() } : {}),
        hiddenCountries: options.hide ? options.hide.split(',').map((c) => c.toUpperCase()) : [],
      };
    }
    case 'rain': {
      const usage =
        'Usage: /rain CURRENCY AMOUNT USERS, for example /rain BTC 0.01 5, /rain BTC 0.01 all or /rain BTC 0.01 10%';
      if (words.length !== 3 && words.length !== 6) return invalid(usage);
      const [currency, amount, who] = [words[0]!, words[1]!, words[2]!];
      const recipients = recipientRule(who);
      if (!CURRENCY.test(currency) || !AMOUNT.test(amount) || !recipients) return invalid(usage);
      let repeatCount: number | null = null;
      let repeatGapSeconds: number | null = null;
      if (words.length === 6) {
        const gap = gapSeconds(words[5]!);
        if (words[3]!.toLowerCase() !== 'repeat' || !/^\d{1,4}$/.test(words[4]!) || gap === null) {
          return invalid(
            'Usage: /rain CURRENCY AMOUNT USERS repeat COUNT GAP, for example /rain BTC 0.01 5 repeat 3 60s (or 5m, 1h)',
          );
        }
        repeatCount = Number(words[4]);
        repeatGapSeconds = gap;
      }
      return {
        kind: 'rain',
        currency: currency.toUpperCase(),
        pot: amount,
        recipients,
        repeatCount,
        repeatGapSeconds,
      };
    }
  }
}

/** `5` (a specific number), `all` (all active users) or `10%` (x% of active users). */
function recipientRule(word: string): RecipientRule | null {
  if (/^all$/i.test(word)) return { mode: 'ALL' };
  const percent = /^(\d{1,3})%$/.exec(word);
  if (percent) {
    const value = Number(percent[1]);
    return value >= 1 && value <= 100 ? { mode: 'PERCENT', percent: value } : null;
  }
  if (!/^\d{1,5}$/.test(word)) return null;
  const count = Number(word);
  return count >= 1 ? { mode: 'SPECIFIC', count } : null;
}

/** "Gap Duration: x Seconds / Minutes / Hours": `60`, `60s`, `5m` or `1h`. */
function gapSeconds(word: string): number | null {
  const match = /^(\d{1,6})([smh]?)$/i.exec(word);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const seconds = unit === 'h' ? value * 3600 : unit === 'm' ? value * 60 : value;
  return seconds >= 1 ? seconds : null;
}
