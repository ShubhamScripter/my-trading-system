'use client';

/**
 * Command suggestions autocomplete — shown above the chat input when user types "/".
 * Also handles keyboard navigation (↑↓ arrows, Enter to select, Escape to close).
 */

import React, { useMemo } from 'react';
import { Terminal } from 'lucide-react';

export interface CommandDef {
  name: string;
  usage: string;
  description: string;
}

/** All available commands (mirrors backend CHAT_COMMANDS). */
export const CHAT_COMMANDS: CommandDef[] = [
  { name: '/help', usage: '/help', description: 'Show all available commands' },
  { name: '/dm', usage: '/dm @username [message]', description: 'Open a DM with a user' },
  { name: '/mute', usage: '/mute @username', description: 'Mute a user (hide their messages)' },
  { name: '/unmute', usage: '/unmute @username', description: 'Unmute a muted user' },
  { name: '/mutelist', usage: '/mutelist', description: 'Show your muted users' },
  { name: '/block', usage: '/block @username', description: 'Block a user' },
  { name: '/unblock', usage: '/unblock @username', description: 'Unblock a blocked user' },
  { name: '/blocklist', usage: '/blocklist', description: 'Show your blocked users' },
  { name: '/send', usage: '/send @username [amount]', description: 'Send a gift to a user' },
  { name: '/ad', usage: '/ad [content]', description: 'Create an advertisement' },
  { name: '/rain', usage: '/rain CURRENCY AMOUNT USERS|all|x% [repeat COUNT 60s|5m|1h]', description: 'Split a pot across people online in this room' },
];

interface CommandSuggestionsProps {
  /** The current input text (should start with '/'). */
  inputText: string;
  /** The index of the currently highlighted suggestion. */
  highlightedIndex: number;
  /** Called when user clicks or presses Enter on a suggestion. */
  onSelect: (command: CommandDef) => void;
}

export default function CommandSuggestions({
  inputText,
  highlightedIndex,
  onSelect,
}: CommandSuggestionsProps) {
  const query = inputText.toLowerCase().trim();

  const suggestions = useMemo(() => {
    if (!query.startsWith('/')) return [];
    if (query === '/') return CHAT_COMMANDS;
    return CHAT_COMMANDS.filter(
      (c) =>
        c.name.toLowerCase().startsWith(query) ||
        c.name.toLowerCase().includes(query.slice(1)),
    );
  }, [query]);

  if (suggestions.length === 0) return null;

  return (
    <div className="command-suggestions" id="command-suggestions">
      <div className="command-suggestion-header">Commands</div>
      {suggestions.map((cmd, i) => (
        <div
          key={cmd.name}
          className={`command-suggestion-item${i === highlightedIndex ? ' highlighted' : ''}`}
          onClick={() => onSelect(cmd)}
          id={`command-suggestion-${cmd.name.slice(1)}`}
        >
          <Terminal size={13} style={{ color: '#818cf8', flexShrink: 0 }} />
          <span className="command-suggestion-name">{cmd.name}</span>
          <span className="command-suggestion-desc">{cmd.description}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Hook that manages command suggestion state for a chat input.
 * Returns the current suggestions list, the highlighted index, and handlers.
 */
export function useCommandSuggestions(
  inputText: string,
  onSelect: (expanded: string) => void,
) {
  const showSuggestions = inputText.trimStart().startsWith('/');
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);

  // Reset highlight when input changes
  React.useEffect(() => {
    setHighlightedIndex(0);
  }, [inputText]);

  const query = inputText.toLowerCase().trim();
  const suggestions = useMemo(() => {
    if (!query.startsWith('/')) return [];
    if (query === '/') return CHAT_COMMANDS;
    return CHAT_COMMANDS.filter(
      (c) =>
        c.name.toLowerCase().startsWith(query) ||
        c.name.toLowerCase().includes(query.slice(1)),
    );
  }, [query]);

  function handleKeyDown(e: React.KeyboardEvent): boolean {
    if (!showSuggestions || suggestions.length === 0) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev + 1) % suggestions.length);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(
        (prev) => (prev - 1 + suggestions.length) % suggestions.length,
      );
      return true;
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      const cmd = suggestions[highlightedIndex];
      if (cmd) {
        e.preventDefault();
        onSelect(cmd.usage + ' ');
        return true;
      }
    }
    return false;
  }

  function handleSelect(cmd: CommandDef) {
    onSelect(cmd.usage + ' ');
  }

  return {
    showSuggestions: showSuggestions && suggestions.length > 0,
    highlightedIndex,
    handleKeyDown,
    handleSelect,
  };
}
