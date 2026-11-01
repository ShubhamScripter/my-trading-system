"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import {
  Wifi,
  Send,
  UserPlus,
  LogIn,
  LogOut,
  Hash,
  Copy,
  Shield,
  Crown,
  Dices,
  MapPin,
  Lock,
  Eye,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
  X,
  User as UserIcon,
  Sparkles,
  Key,
  Users,
  Globe,
  Languages,
  Check,
  CheckSquare,
  Square,
  Smile,
  Image as ImageIcon,
  Film,
  Bell,
  Flag,
  Undo2,
  AlertTriangle,
  Clock,
  ExternalLink,
  MessageSquare,
  ArrowLeft,
  Search,
  ChevronRight,
  BookOpen,
  Palette,
  Ghost,
  Flame,
  Zap,
  Gem,
  Trophy,
  ThumbsUp,
  Heart,
  Store,
  Star,
  ArrowRight,
  Gift,
  Megaphone,
  VolumeX,
  CloudRain,
  Wallet,
} from "lucide-react";

import type { User, OnlineUser, RoomItem, Message, RoomRules, CosmeticItem } from "@/types/chat";
import ChatMessageList from "@/components/chat/ChatMessageList";
import GiftModal from "@/components/chat/GiftModal";
import CommandSuggestions from "@/components/chat/CommandSuggestions";
import DmPanel from "@/components/chat/DmPanel";
import MyAdsModal from "@/components/chat/MyAdsModal";
import MuteBlockPanel from "@/components/chat/MuteBlockPanel";
import SupportPanel from "@/components/chat/SupportPanel";
import StaffToolsPanel from "@/components/chat/staff/StaffToolsPanel";
import CommandResultCard, { describeCommand, type CommandOutput } from "@/components/chat/CommandResultCard";
import RainPoolPanel, { rainCountdown } from "@/components/chat/RainPoolPanel";
import RainVerifyModal from "@/components/chat/RainVerifyModal";
import * as rainApi from "@/lib/api/rain";
import * as staffApi from "@/lib/api/staff";
import * as socialApi from "@/lib/api/social";
import type { Ad } from "@/types/dm";
import { ApiError } from "@/lib/api/client";
import * as authApi from "@/lib/api/auth";
import * as roomsApi from "@/lib/api/rooms";
import * as messagesApi from "@/lib/api/messages";
import {
  createChatSocket,
  type AckResponse,
  type ChatSocket,
  type JoinRoomAckData,
  type LeaveRoomAckData,
  type RetractMessageAckData,
  type SendMessageAckData,
} from "@/lib/socket";

const getRoomIcon = (room?: RoomItem | null, size = 18) => {
  if (!room) return <MessageSquare size={size} className="text-slate-400" />;
  switch (room.type) {
    case "PREMIUM":
      return <Sparkles size={size} className="text-sky-400" />;
    case "CASINO":
      return <Dices size={size} className="text-yellow-400" />;
    case "KYC":
      return <Shield size={size} className="text-emerald-400" />;
    case "SO":
      return <Store size={size} className="text-amber-500" />;
    case "COUNTRY":
    case "CONTINENT":
    case "REGION":
    case "LANGUAGE":
      return <Globe size={size} className="text-teal-400" />;
    case "GLOBAL":
      return <Globe size={size} className="text-indigo-400" />;
    default:
      return <MessageSquare size={size} className="text-slate-400" />;
  }
};

const getRoomBadgeClass = (room: RoomItem) => {
  switch (room.type) {
    case "PREMIUM":
      return "badge-tint-premium";
    case "CASINO":
      return "badge-tint-casino";
    case "KYC":
      return "badge-tint-kyc";
    case "SO":
      return "badge-tint-so";
    case "COUNTRY":
    case "CONTINENT":
    case "REGION":
    case "LANGUAGE":
      return "badge-tint-region";
    default:
      return "badge-tint-default";
  }
};

// 2.1.1 Default room on load = last-opened room, saved client-side (LocalStorage)
const LAST_ROOM_STORAGE_KEY = "orebit_last_room_id";

export default function Home() {
  const [mounted, setMounted] = useState(false);

  // Connection state
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);

  // Auth Modal State
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authTab, setAuthTab] = useState<"login" | "signup">("login");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuccess, setAuthSuccess] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);

  // Socket.io instance
  const [socket, setSocket] = useState<ChatSocket | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [socketConnecting, setSocketConnecting] = useState(false);
  const [socketError, setSocketError] = useState<string | null>(null);

  // Rooms state
  const [rooms, setRooms] = useState<RoomItem[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [activeRoomId, setActiveRoomId] = useState(
    "00000000-0000-0000-0000-000000000000",
  );
  const [joinedRoomId, setJoinedRoomId] = useState<string | null>(null);
  const [languageFilter, setLanguageFilter] = useState("ALL");

  // Navigation View State: 'rooms' = outside room directory only, 'chat' = inside active room chat box
  const [currentView, setCurrentView] = useState<"rooms" | "chat">("rooms");
  const [roomSearchQuery, setRoomSearchQuery] = useState("");

  // Online Presence state
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [isOnlineDrawerOpen, setIsOnlineDrawerOpen] = useState(true);

  // Messages & scrollback
  const [messages, setMessages] = useState<Message[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Non-blocking notices (moderation notes, refusals) shown at the top of the page.
  const [notice, setNotice] = useState<{ text: string; kind: "info" | "error" } | null>(null);
  const showNotice = (text: string, kind: "info" | "error" = "error") => {
    setNotice({ text, kind });
    window.setTimeout(() => setNotice((current) => (current?.text === text ? null : current)), 8000);
  };

  // The profile card (M1-14): opened from a message author or the online list.
  const [profileCard, setProfileCard] = useState<roomsApi.ProfileCard | null>(null);
  const [reportingUser, setReportingUser] = useState<{ id: string; username: string } | null>(null);
  const openProfile = async (handle: string) => {
    if (!token || !handle) return;
    try {
      setProfileCard(await roomsApi.getProfile(token, handle));
    } catch (err) {
      showNotice(err instanceof ApiError ? err.message : "Could not load this profile");
    }
  };

  // The GIF provider the admin chose (D-29); the picker searches only that provider.
  const [gifProvider, setGifProvider] = useState<"TENOR" | "GIPHY">("TENOR");

  // Inputs
  const [messageText, setMessageText] = useState("");
  const [signupForm, setSignupForm] = useState({
    email: "",
    username: "",
    password: "",
    country: "IN",
  });
  const [loginForm, setLoginForm] = useState({
    usernameOrEmail: "",
    password: "",
  });

  // Module 3 Features State
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showGifModal, setShowGifModal] = useState(false);
  const [gifSearchQuery, setGifSearchQuery] = useState("");
  const [gifSearchResults, setGifSearchResults] = useState<
    Array<{ id: string; url: string; label: string }>
  >([]);
  const [gifSearching, setGifSearching] = useState(false);
  const [showMediaModal, setShowMediaModal] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportingMessage, setReportingMessage] = useState<Message | null>(
    null,
  );
  const [reportForm, setReportForm] = useState({ reason: "", details: "" });
  const [reportReasons, setReportReasons] = useState<{ code: string; label: string }[]>([]);
  const [reportSubmitting, setReportSubmitting] = useState(false);

  // Rate Limiting & Cooldown state
  const [rateLimitCooldown, setRateLimitCooldown] = useState<number | null>(
    null,
  );
  const [mediaCooldown, setMediaCooldown] = useState<number | null>(null);

  // Mentions / Tagged feed state
  const [unreadMentionsCount, setUnreadMentionsCount] = useState(0);
  const [isViewingMentionsFeed, setIsViewingMentionsFeed] = useState(false);

  // Custom Media / GIF inputs
  const [customMediaUrl, setCustomMediaUrl] = useState("");
  const [customMediaType, setCustomMediaType] = useState<
    "image" | "video" | "gif"
  >("image");
  const [customMediaCaption, setCustomMediaCaption] = useState("");
  const [mediaUploading, setMediaUploading] = useState(false);

  // Module 3: Chat Rules Box, Cosmetics, Anonymous Mode
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [roomRules, setRoomRules] = useState<RoomRules | null>(null);
  const [loadingRules, setLoadingRules] = useState(false);

  const [showCosmeticsModal, setShowCosmeticsModal] = useState(false);
  const [cosmeticsList, setCosmeticsList] = useState<CosmeticItem[]>([]);
  const [activeCosmeticId, setActiveCosmeticId] = useState<string | null>(null);
  const [loadingCosmetics, setLoadingCosmetics] = useState(false);

  const [isAnonymousMode, setIsAnonymousMode] = useState(false);

  // Modules 5, 8, 9 Modals & Panels State
  const [showDmPanel, setShowDmPanel] = useState(false);
  const [showAdsModal, setShowAdsModal] = useState(false);
  const [showMuteBlockPanel, setShowMuteBlockPanel] = useState(false);
  const [showSupportPanel, setShowSupportPanel] = useState(false);
  const [showGiftModal, setShowGiftModal] = useState(false);
  // Module 4: the staff tools (only chat staff see the button).
  const [showStaffTools, setShowStaffTools] = useState(false);
  // Module 5: the ad pinned on top of the open room.
  const [pinned, setPinned] = useState<{ roomId: string; ad: Ad | null } | null>(null);
  const [commandHighlightedIndex, setCommandHighlightedIndex] = useState(0);
  // Module 5: what the last command answered, a /send waiting for its PIN / 2FA, a /dm to open.
  const [commandOutput, setCommandOutput] = useState<CommandOutput | null>(null);
  const [pendingGift, setPendingGift] = useState<React.ComponentProps<typeof GiftModal>["pending"] | null>(null);
  const [dmOpenConversationId, setDmOpenConversationId] = useState<string | undefined>(undefined);
  // Module 4: my staff permissions (ACT or REPORT), and the messages staff pinned in the open room.
  const [staffPerms, setStaffPerms] = useState<staffApi.StaffPermissions | null>(null);
  const [roomPinned, setRoomPinned] = useState<{ roomId: string; items: Message[] } | null>(null);
  const [showRoomPinned, setShowRoomPinned] = useState(false);
  // RainPool (Modules 6–7): the next Rainpool rain for the header, the panel, and a /rain waiting for its codes.
  const [rainSchedule, setRainSchedule] = useState<{
    systemStatus: string;
    nextRainAt: string | null;
    scheduledAt: string | null;
    nextCurrency: string | null;
    nextPot: string | null;
    nextPotUsd?: string | null;
  } | null>(null);
  const [showRainPanel, setShowRainPanel] = useState(false);
  const [rainRefreshKey, setRainRefreshKey] = useState(0);
  const [pendingRain, setPendingRain] = useState<rainApi.RainResult | null>(null);
  const [walletBalances, setWalletBalances] = useState<rainApi.RainBalances | null>(null);
  const [rainNow, setRainNow] = useState(() => Date.now());

  useEffect(() => {
    if (!token) return;
    let live = true;
    const load = () => {
      rainApi
        .getRainState()
        .then(
          (s) =>
            live &&
            setRainSchedule({
              systemStatus: s.system.status,
              nextRainAt: s.system.nextRainAt,
              scheduledAt: s.system.scheduledAt,
              nextCurrency: s.system.nextCurrency,
              nextPot: s.system.nextPot,
              nextPotUsd: s.system.nextPotUsd,
            }),
        )
        .catch(() => {});
      // The balance moves with every rain sent, received or reversed, which all bump rainRefreshKey.
      rainApi
        .getRainBalances()
        .then((b) => live && setWalletBalances(b))
        .catch(() => {});
    };
    void load();
    // A missed socket event (reconnect) is caught up by a gentle poll.
    const poll = window.setInterval(load, 60_000);
    const tick = window.setInterval(() => setRainNow(Date.now()), 1000);
    return () => {
      live = false;
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [token, rainRefreshKey]);

  useEffect(() => {
    if (!showReportModal || !token) return;
    messagesApi
      .getReportReasons(token)
      .then((items) => {
        setReportReasons(items);
        setReportForm((prev) => ({ ...prev, reason: items.some((r) => r.code === prev.reason) ? prev.reason : items[0]?.code ?? "" }));
      })
      .catch(() => setReportReasons([]));
  }, [showReportModal, token]);

  // Rate Limit Countdown Timers
  useEffect(() => {
    if (rateLimitCooldown && rateLimitCooldown > 0) {
      const timer = setInterval(() => {
        setRateLimitCooldown((prev) => (prev && prev > 1 ? prev - 1 : null));
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [rateLimitCooldown]);

  useEffect(() => {
    if (mediaCooldown && mediaCooldown > 0) {
      const timer = setInterval(() => {
        setMediaCooldown((prev) => (prev && prev > 1 ? prev - 1 : null));
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [mediaCooldown]);

  // Refs
  const socketRetryRef = useRef(0);
  const chatFeedEndRef = useRef<HTMLDivElement>(null);
  const activeRoomIdRef = useRef(activeRoomId);
  activeRoomIdRef.current = activeRoomId;

  useEffect(() => {
    if (!token || !activeRoomId) return;
    let live = true;
    void socialApi.getPinnedAd(activeRoomId).then((ad) => live && setPinned({ roomId: activeRoomId, ad }));
    return () => {
      live = false;
    };
  }, [activeRoomId, token]);
  // Only the open room's pinned ad shows.
  const pinnedAd = pinned?.roomId === activeRoomId ? pinned.ad : null;

  // Pinned messages of the open room (Module 4 "Pin Messages in Chat Rooms").
  const loadRoomPinned = (roomId: string) =>
    messagesApi
      .getPinnedMessages(roomId)
      .then((items) => setRoomPinned({ roomId, items }))
      .catch(() => setRoomPinned({ roomId, items: [] }));
  useEffect(() => {
    if (!token || !activeRoomId) return;
    let live = true;
    messagesApi
      .getPinnedMessages(activeRoomId)
      .then((items) => live && setRoomPinned({ roomId: activeRoomId, items }))
      .catch(() => live && setRoomPinned({ roomId: activeRoomId, items: [] }));
    return () => {
      live = false;
    };
  }, [activeRoomId, token]);
  const pinnedMessages = roomPinned?.roomId === activeRoomId ? roomPinned.items : [];

  // The staff role comes from chat; its permissions decide which staff buttons show (the server checks again).
  useEffect(() => {
    if (!user?.staffRole) return;
    staffApi.getPermissions().then(setStaffPerms).catch(() => setStaffPerms(null));
  }, [user?.staffRole]);
  const staffHas = (name: string) => (staffPerms?.permissions[name] ?? "NONE") !== "NONE";
  const staffFlags = staffPerms && user?.staffRole
    ? { canPin: staffHas("PIN"), canDelete: staffHas("DELETE_MESSAGES"), seeDeleted: staffPerms.permissions.SEE_DELETED === "ACT" }
    : undefined;

  // Load token & user from localStorage on mount
  useEffect(() => {
    setMounted(true);
    const savedToken = localStorage.getItem("orebit_token");
    const savedUser = localStorage.getItem("orebit_user");
    if (savedToken) setToken(savedToken);
    if (savedUser) {
      try {
        setUser(JSON.parse(savedUser));
      } catch (e) {
        localStorage.removeItem("orebit_user");
      }
    }

    // 2.1.1: restore the last-opened room from LocalStorage and drop the user
    // straight back into it instead of the room directory.
    const savedRoomId = localStorage.getItem(LAST_ROOM_STORAGE_KEY);
    if (savedToken && savedRoomId) {
      setActiveRoomId(savedRoomId);
      setCurrentView("chat");
    }
  }, []);

  // Fetch rooms and preferences when token changes
  useEffect(() => {
    if (token) {
      fetchRooms();
      fetchPreferences();
      loadCosmeticsList();
    } else {
      setRooms([]);
    }
  }, [token]);

  // Auto connect socket when token is ready
  useEffect(() => {
    if (token && !socketConnected && !socketConnecting && !socket) {
      handleConnectSocket();
    }
  }, [token]);

  // Scroll chat feed to bottom
  useEffect(() => {
    if (chatFeedEndRef.current) {
      chatFeedEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Cleanup socket on unmount
  useEffect(() => {
    return () => {
      if (socket) socket.disconnect();
    };
  }, [socket]);

  const fetchRooms = async (tokenOverride?: string) => {
    const activeTok =
      tokenOverride || token || localStorage.getItem("orebit_token");
    if (!activeTok) return;
    setLoadingRooms(true);

    try {
      const { items: data, gifProvider: provider } = await roomsApi.getRoomList(activeTok);
      if (provider) setGifProvider(provider);
      const accessibleRooms = (Array.isArray(data) ? data : []).filter(
        (r: RoomItem) => r.accessMode !== "LOCKED" && r.isEligibleToView !== false,
      );
      setRooms(accessibleRooms);
    } catch (err: any) {
      setRooms([]);
    } finally {
      setLoadingRooms(false);
    }
  };

  // Fetch online users for a specific room
  const fetchOnlineUsers = async (roomId: string) => {
    const activeTok = token || localStorage.getItem("orebit_token");
    if (!activeTok) return;
    try {
      const data = await roomsApi.getRoomOnlineUsers(roomId, activeTok);
      if (Array.isArray(data.users)) {
        setOnlineUsers(data.users);
        setRooms((prev) =>
          prev.map((c) =>
            c.id === roomId || c.slug === roomId ? { ...c, onlineCount: data.count } : c,
          ),
        );
      }
    } catch {}
  };

  // Fetch user preferences (e.g. last opened room)
  const fetchPreferences = async (tokenOverride?: string) => {
    const activeTok =
      tokenOverride || token || localStorage.getItem("orebit_token");
    if (!activeTok) return;
    try {
      const prefs = await roomsApi.getPreferences(activeTok);
      // The server decides the room that opens: the last room it kept, else the admin's default (D-17, D-38).
      if (prefs?.effectiveDefaultRoomId) {
        setActiveRoomId(prefs.effectiveDefaultRoomId);
        if (prefs.effectiveDefaultRoomId !== "00000000-0000-0000-0000-000000000000") setCurrentView("chat");
      }
      setActiveCosmeticId(prefs?.activeSkinId ?? null);
      setIsAnonymousMode(Boolean(prefs?.hideIdentity));
      // The chat staff role comes from chat (assigned in the admin panel), never from the client.
      setUser((prev) => (prev ? { ...prev, staffRole: prefs?.staffRole ?? null } : prev));
    } catch {}
  };

  // Socket Connection Handling
  const handleConnectSocket = (tokenOverride?: string) => {
    const activeTok =
      tokenOverride || token || localStorage.getItem("orebit_token");
    if (!activeTok) {
      setIsAuthModalOpen(true);
      return;
    }

    if (socket) {
      socket.disconnect();
    }

    setSocketConnecting(true);
    setSocketError(null);

    const newSocket = createChatSocket(activeTok, activeRoomId);

    newSocket.on("connect", () => {
      socketRetryRef.current = 0;
      setSocketConnected(true);
      setSocketConnecting(false);
      setSocketError(null);

      // Join active room in background without forcing navigation
      switchRoom(activeRoomId, newSocket, false);
    });

    newSocket.on("disconnect", () => {
      setSocketConnected(false);
      setSocketConnecting(false);
      setJoinedRoomId(null);
    });

    newSocket.on("session_ended", () => {
      setSocketError("Your session ended. Please sign in again.");
      showNotice("You were signed out (logged out in another tab or your session ended). Please sign in again.");
    });

    newSocket.on("session_replaced", () => {
      setSocketError("Session replaced: Maximum connections reached or signed in elsewhere.");
      showNotice("This tab was disconnected because chat is open in too many tabs. Close another tab and reload this one.");
    });

    newSocket.on("connect_error", async (error) => {
      setSocketConnected(false);
      const reason = error.message;
      // Recoverable: the access token is due (refresh it over HTTP), Redis blipped, or the server is busy.
      const retryable = ["session_refresh_required", "session_store_unavailable", "server_busy"].includes(reason);
      if (retryable && socketRetryRef.current < 5) {
        socketRetryRef.current += 1;
        setSocketConnecting(true);
        if (reason === "session_refresh_required") await authApi.currentSession();
        const delay = Math.min(8000, 500 * 2 ** socketRetryRef.current) + Math.floor(Math.random() * 500);
        window.setTimeout(() => newSocket.connect(), delay);
        return;
      }
      setSocketConnecting(false);
      setSocketError(reason);
    });

    newSocket.on("new_message", (msg: Message) => {
      const msgRoom = msg.roomId || (msg as any).channelId;
      const currentActive = activeRoomIdRef.current;
      const isMatching =
        msgRoom === currentActive ||
        currentActive === "00000000-0000-0000-0000-000000000000" ||
        currentActive === "global";

      if (isMatching) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
      }
    });

    newSocket.on("new_messages", (payload: any) => {
      const list: Message[] = Array.isArray(payload) ? payload : payload?.messages || [];
      const currentActive = activeRoomIdRef.current;
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const filtered = list.filter((msg) => {
          const msgRoom = msg.roomId || (msg as any).channelId;
          const isMatching =
            msgRoom === currentActive ||
            currentActive === "00000000-0000-0000-0000-000000000000" ||
            currentActive === "global";
          return isMatching && !existingIds.has(msg.id);
        });
        return [...prev, ...filtered];
      });
    });

    newSocket.on(
      "rate_limit_cooldown",
      (data: { remainingSeconds: number; reason: string }) => {
        setRateLimitCooldown(data.remainingSeconds || 10);
      },
    );

    newSocket.on(
      "moderation_notice",
      (data: { action?: string; note?: string | null; expiresAt?: string | null }) => {
        const action = (data?.action || "").toLowerCase();
        const title =
          action === "ban"
            ? `You are banned from chat${data.expiresAt ? ` until ${new Date(data.expiresAt).toLocaleString()}` : " permanently"}`
            : action === "unban"
              ? "Your chat ban was lifted"
              : action === "warn"
                ? "You received a warning"
                : action === "retract"
                  ? "A moderator retracted your message"
                  : action === "restrict"
                    ? `A chat restriction was placed on you${data.expiresAt ? ` until ${new Date(data.expiresAt).toLocaleString()}` : ""}`
                    : action === "unrestrict"
                      ? "A chat restriction on you was lifted"
                      : action === "gift_reverted"
                        ? "A gift you sent or received was reverted by an admin"
                        : action === "request_approved"
                          ? "Your staff request was approved"
                          : action === "request_rejected"
                            ? "Your staff request was rejected"
                            : "Moderation notice";
        const good = ["unban", "unrestrict", "request_approved"].includes(action);
        showNotice(data?.note ? `${title}: ${data.note}` : title, good ? "info" : "error");
      },
    );

    // Module 5: a gift reached me, and the pinned ad of a room changed.
    newSocket.on(
      "gift_received",
      (data: { amount: string; currency: string; senderUsername: string }) => {
        showNotice(`🎁 @${data.senderUsername} sent you ${data.amount} ${data.currency}`, "info");
      },
    );
    // RainPool: every one of these arrives only after the money moved.
    newSocket.on("rain_received", (data) => {
      showNotice(`🌧️ You caught ${data.amount} ${data.currency} from a ${data.kind === "SYSTEM" ? "Rainpool rain" : "rain"}!`, "info");
      setRainRefreshKey((k) => k + 1);
    });
    newSocket.on("rain_completed", () => setRainRefreshKey((k) => k + 1));
    newSocket.on("rain_reversed", (data) => {
      showNotice(`A rain in ${data.currency} was reversed by an admin: ${data.reason}`, "info");
      setRainRefreshKey((k) => k + 1);
    });
    newSocket.on("rain_state", (data) => setRainSchedule(data));
    // An admin reviewing my rain asked for the questionnaire or a KYC check: open it.
    newSocket.on("rain_verification_requested", (data) => {
      void rainApi
        .getPendingRains()
        .then((items) => {
          const asked = items.find((p) => p.rainId === data.rainId);
          if (asked) setPendingRain(asked);
        })
        .catch(() => {});
    });
    // An admin approved or rejected my rain under manual verification.
    newSocket.on("rain_reviewed", (data) => {
      showNotice(
        data.decision === "APPROVE"
          ? "🌧️ Your rain was approved and paid"
          : `Your rain was rejected by an admin${data.reason ? `: ${data.reason}` : ""}. Nothing was taken.`,
        "info",
      );
      setRainRefreshKey((k) => k + 1);
    });
    // An admin changed the RainPool settings or status: reload the state (header countdown and the open panel).
    newSocket.on("rain_config_changed", () => setRainRefreshKey((k) => k + 1));
    newSocket.on("ad_pinned", (data: { roomId: string }) => {
      if (data?.roomId === activeRoomIdRef.current) {
        void socialApi.getPinnedAd(data.roomId).then((ad) => setPinned({ roomId: data.roomId, ad }));
      }
    });
    newSocket.on("ad_unpinned", (data: { roomId: string }) => {
      if (data?.roomId === activeRoomIdRef.current) setPinned({ roomId: data.roomId, ad: null });
    });

    // Module 4: staff pinned or unpinned a message in a room I am in.
    const onMessagePin = (isPinned: boolean) => (data: { messageId: string; roomId: string }) => {
      setMessages((prev) => prev.map((m) => (m.id === data.messageId ? { ...m, isPinned } : m)));
      const current = activeRoomIdRef.current;
      void messagesApi.getPinnedMessages(current).then((items) => setRoomPinned({ roomId: current, items })).catch(() => {});
    };
    newSocket.on("message_pinned", onMessagePin(true));
    newSocket.on("message_unpinned", onMessagePin(false));

    // Module 4: a lower role asked me to act (REPORT mode); it waits under Staff Tools → Requests.
    newSocket.on(
      "staff_request",
      (data: { permission?: string; requesterUsername?: string; note?: string }) => {
        showNotice(
          `Staff request from @${data?.requesterUsername ?? "staff"}: ${(data?.permission ?? "").replace(/_/g, " ").toLowerCase()}${data?.note ? ` — ${data.note}` : ""}. Open Staff Tools → Requests.`,
          "info",
        );
      },
    );

    newSocket.on(
      "online_count_updated",
      (data: { roomId: string; count: number }) => {
        if (data?.roomId && typeof data?.count === "number") {
          setRooms((prev) =>
            prev.map((c) =>
              c.id === data.roomId || c.slug === data.roomId
                ? { ...c, onlineCount: data.count }
                : c,
            ),
          );
          fetchOnlineUsers(data.roomId);
        }
      },
    );

    newSocket.on(
      "message_retracted",
      (data: {
        messageId: string;
        roomId: string;
        retractedAt: string;
      }) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === data.messageId
              ? {
                  ...m,
                  retractedAt: data.retractedAt,
                }
              : m,
          ),
        );
      },
    );

    newSocket.on(
      "user_tagged",
      (data: {
        roomId: string;
        messageId: string;
        senderUsername: string;
        taggedUsernames: string[];
        content: string;
      }) => {
        const myUsername = localStorage.getItem("orebit_user")
          ? JSON.parse(localStorage.getItem("orebit_user") || "{}")?.username
          : user?.username;

        if (
          myUsername &&
          data.taggedUsernames
            ?.map((u: string) => u.toLowerCase())
            .includes(myUsername.toLowerCase())
        ) {
          setUnreadMentionsCount((prev) => prev + 1);
        }
      },
    );

    const handleOnlineUsersEvent = (data: {
      roomId?: string;
      count?: number;
      users?: OnlineUser[];
    }) => {
      if (Array.isArray(data?.users)) {
        setOnlineUsers(data.users);
      }
      const targetId = data?.roomId;
      if (targetId && typeof data?.count === "number") {
        setRooms((prev) =>
          prev.map((c) =>
            c.id === targetId || c.slug === targetId
              ? { ...c, onlineCount: data.count }
              : c,
          ),
        );
      }
    };

    newSocket.on("online_users", handleOnlineUsersEvent);
    newSocket.on("online_users_updated", handleOnlineUsersEvent);

    newSocket.on(
      "user_presence",
      (data: { userId: string; username: string; isOnline: boolean }) => {
        if (!data.isOnline) {
          setOnlineUsers((prev) => prev.filter((u) => u.id !== data.userId));
        }
      },
    );

    const handleRoomAccessEvent = (data: any) => {
      const targetId = data?.roomId || data?.channelId;
      if (data?.status === "removed" && targetId && activeRoomIdRef.current === targetId) {
        showNotice(data?.access?.reason || "This room is no longer available to you.", "info");
        fetchRooms();
        switchRoom("00000000-0000-0000-0000-000000000000", newSocket, true);
        return;
      }
      if (data?.access && targetId) {
        setRooms((prev) =>
          prev.map((c) =>
            c.id === targetId || c.slug === targetId
              ? { ...c, ...data.access }
              : c,
          ),
        );
      }
      if (Array.isArray(data?.onlineUsers)) {
        setOnlineUsers(data.onlineUsers);
      }
    };

    newSocket.on("room_access", handleRoomAccessEvent);
    newSocket.on("channel_access", handleRoomAccessEvent);

    const handleRoomLeftEvent = (data: any) => {
    };

    newSocket.on("room_left", handleRoomLeftEvent);
    newSocket.on("leave_room", handleRoomLeftEvent);
    newSocket.on("channel_left", handleRoomLeftEvent);

    // The room list changed for this user (admin edit, new room, eligibility change): reload it (D-24).
    newSocket.on("rooms_changed", () => {
      // Spread the reloads so one change does not make every client ask at the same moment.
      setTimeout(() => fetchRooms(), Math.floor(Math.random() * 2000));
    });

    newSocket.on("exception", (err: any) => {
    });

    setSocket(newSocket);
  };

  const handleDisconnect = () => {
    if (socket) {
      socket.disconnect();
      setSocket(null);
    }
    setSocketConnected(false);
    setSocketConnecting(false);
    setJoinedRoomId(null);
  };

  // Switch Active Room
  const switchRoom = (
    roomId: string,
    currentSocket: ChatSocket | null = socket,
    navigateToChat = true,
  ) => {
    const targetRoom = rooms.find((c) => c.id === roomId || c.slug === roomId);
    setActiveRoomId(roomId);
    setIsViewingMentionsFeed(false);
    setMessages([]);
    setNextCursor(null);

    if (navigateToChat) {
      setCurrentView("chat");
    }

    // If client-side metadata already knows room is locked, prevent joining
    if (
      targetRoom &&
      targetRoom.accessMode === "LOCKED" &&
      !targetRoom.isEligibleToView
    ) {
      setJoinedRoomId(null);
      return;
    }

    const prevRoomId = joinedRoomId;

    if (currentSocket && currentSocket.connected) {
      // Cleanly leave previous room if leaving a non-global room
      if (
        prevRoomId &&
        prevRoomId !== roomId &&
        prevRoomId !== "00000000-0000-0000-0000-000000000000"
      ) {
        // The ack carries only {roomId}; nothing here reads it — leaving a
        // room updates local state via switchRoom's own join, not via this ack.
        currentSocket.emit(
          "leave_room",
          { roomId: prevRoomId },
          (_ack: AckResponse<LeaveRoomAckData>) => {},
        );
      }

      currentSocket.emit(
        "join_room",
        { roomId },
        (response: AckResponse<JoinRoomAckData>) => {
          // A refused join still carries the room and its access evaluation —
          // over HTTP it always did, in `extra`; the ack now mirrors that
          // instead of putting it under `data` only on the success branch.
          const access = response.ok ? response.data.access : (response.error.extra?.access as Partial<RoomItem> | undefined);
          const targetId = response.ok
            ? response.data.roomId
            : ((response.error.extra?.roomId as string | undefined) ?? roomId);

          if (access && targetId) {
            setRooms((prev) =>
              prev.map((c) =>
                c.id === targetId || c.slug === targetId ? { ...c, ...access } : c,
              ),
            );
          }

          if (!response.ok || access?.isEligibleToView === false) {
            setJoinedRoomId(null);
            // 2.1.1 edge case: last-opened room became disabled/inaccessible —
            // fall back to Global Chat next time instead of repeating the failure.
            if (localStorage.getItem(LAST_ROOM_STORAGE_KEY) === targetId) {
              localStorage.removeItem(LAST_ROOM_STORAGE_KEY);
            }
          } else {
            setJoinedRoomId(targetId);
            localStorage.setItem(LAST_ROOM_STORAGE_KEY, targetId);
          }
        },
      );
    }

    if (!targetRoom || targetRoom.isEligibleToView) {
      fetchHistory(roomId, true);
      fetchOnlineUsers(roomId);
    }
  };

  // HTTP API: Load room scrollback logs
  const fetchHistory = async (roomId: string, isFirstLoad = false) => {
    if (!token) return;

    setLoadingHistory(true);

    try {
      const data = await messagesApi.getHistory(roomId, token, {
        cursor: !isFirstLoad ? nextCursor : undefined,
      });

      setMessages((prev) => {
        if (isFirstLoad) {
          return [...(data.messages || [])].reverse();
        } else {
          const merged = [...(data.messages || []), ...prev];
          const unique = merged.filter(
            (item, index) =>
              merged.findIndex((m) => m.id === item.id) === index,
          );
          return unique.sort(
            (a, b) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          );
        }
      });

      setNextCursor(data.nextCursor || null);
    } catch (err: any) {
    } finally {
      setLoadingHistory(false);
    }
  };

  // Send Message
  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!socket || !socketConnected || !joinedRoomId) {
      showNotice("Must connect socket and join a room before sending messages!");
      return;
    }

    if (!messageText.trim()) return;

    const currentRoom = rooms.find(
      (c) => c.id === activeRoomId || c.slug === activeRoomId,
    );
    if (currentRoom && currentRoom.accessMode === "VIEW_ONLY") {
      showNotice(
        `Cannot send message: ${currentRoom.reason || "This room is currently in View-Only mode for your account."}`,
      );
      return;
    }

    const payload = {
      roomId: joinedRoomId,
      content: messageText,
      ...(activeCosmeticId ? { skinId: activeCosmeticId } : {}),
      clientMessageId: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : undefined,
    };

    socket.emit(
      "send_message",
      payload,
      (ack: AckResponse<SendMessageAckData>) => {
        if (ack.ok) {
          if (ack.data?.command) handleCommandResult(ack.data.command, ack.data.result);
          return;
        }
        if (ack.error.type === "rate_limited") {
          setRateLimitCooldown(
            (ack.error.extra?.remainingSeconds as number | undefined) ??
              ack.error.retryAfterSeconds ??
              10,
          );
        } else {
          showNotice((ack.error as any).errors?.[0]?.message || ack.error.detail || ack.error.title || "Your message could not be sent.");
        }
      },
    );

    setMessageText("");
  };

  // Module 5: a command ran instead of being posted. /dm opens the conversation, /send asks for the PIN / 2FA code,
  // the others answer in a card above the composer.
  /* eslint-disable @typescript-eslint/no-explicit-any -- command results differ per command */
  const handleCommandResult = (command: string, result: any) => {
    if (command === "dm" && result?.conversationId) {
      setDmOpenConversationId(result.conversationId);
      setShowDmPanel(true);
      showNotice(`Message sent to @${result.otherUser?.username ?? "user"}`, "info");
      return;
    }
    if (command === "rain" && result?.status === "PENDING_VERIFICATION" && result?.verification) {
      setPendingRain(result);
      return;
    }
    if (command === "rain") setRainRefreshKey((k) => k + 1);
    if (command === "send" && result?.giftId) {
      setPendingGift({
        giftId: result.giftId,
        recipient: result.recipient?.username ?? "",
        amount: result.amount,
        currency: result.currency,
        verification: result.verification,
      });
      return;
    }
    const undo = async (list: "mutes" | "blocks", username: string) => {
      try {
        await (list === "mutes" ? socialApi.unmuteUser(username) : socialApi.unblockUser(username));
        setCommandOutput((prev) =>
          prev ? { ...prev, people: prev.people?.filter((p) => p.username !== username) } : prev,
        );
      } catch (err) {
        showNotice(err instanceof Error ? err.message : "That did not work");
      }
    };
    const output = describeCommand(command, result, (list, username) => void undo(list, username));
    if (output) setCommandOutput(output);
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // Module 4: staff pin / unpin. A REPORT-only role sends a request to a higher role instead.
  const handleTogglePin = async (msg: Message) => {
    try {
      const res = await messagesApi.setMessagePinned(msg.id, !msg.isPinned);
      if (res.requested) {
        showNotice("Your role can only request this: the request was sent to a higher role.", "info");
        return;
      }
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, isPinned: !msg.isPinned } : m)));
      void loadRoomPinned(activeRoomId);
    } catch (err) {
      showNotice(err instanceof ApiError ? err.message : "Could not change the pin");
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMessageText(e.target.value);
  };

  // Insert reaction tag into input
  const handleInsertEmoji = (reactionCode: string) => {
    setMessageText(
      (prev) =>
        (prev && !prev.endsWith(" ") ? `${prev} ` : prev) + `${reactionCode} `,
    );
    setShowEmojiPicker(false);
  };

  // Retract Message handler
  const handleRetractMessage = async (messageId: string) => {
    if (!confirm("Are you sure you want to retract this message?")) return;

    if (socket && socketConnected) {
      socket.emit(
        "retract_message",
        { messageId },
        (res: AckResponse<RetractMessageAckData>) => {
          if (res.ok && (res.data as { requested?: boolean })?.requested) {
            // Staff with "Delete Messages" in REPORT mode: a higher role decides.
            showNotice("Your role can only request this: the request was sent to a higher role.", "info");
            return;
          }
          if (res.ok) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      retractedAt: res.data.retractedAt || new Date().toISOString(),
                    }
                  : m,
              ),
            );
          } else {
            showNotice((res.error as any).errors?.[0]?.message || res.error.detail || res.error.title || "Failed to retract message");
          }
        },
      );
      return;
    }

    try {
      const data = await messagesApi.retractMessage(messageId, token as string);
      if ((data as { requested?: boolean }).requested) {
        showNotice("Your role can only request this: the request was sent to a higher role.", "info");
        return;
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                retractedAt: data.retractedAt || new Date().toISOString(),
              }
            : m,
        ),
      );
    } catch (err) {
      showNotice(err instanceof ApiError ? err.message : "Failed to retract message");
    }
  };

  // Submit Content Report
  const handleSubmitReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!reportingMessage && !reportingUser) || !token) return;
    setReportSubmitting(true);
    try {
      const form = { reason: reportForm.reason, ...(reportForm.details.trim() ? { details: reportForm.details.trim() } : {}) };
      if (reportingMessage) await messagesApi.reportMessage(reportingMessage.id, token, form as typeof reportForm);
      else if (reportingUser) await messagesApi.reportUser(reportingUser.id, token, form as typeof reportForm);
      showNotice("Report submitted! Moderators have been alerted.", "info");
      setShowReportModal(false);
      setReportingMessage(null);
      setReportingUser(null);
      setReportForm({ reason: "", details: "" });
    } catch (err) {
      if (err instanceof ApiError) {
        showNotice(`Could not submit report: ${err.message}`);
      }
    } finally {
      setReportSubmitting(false);
    }
  };

  // Send Media / GIF message
  const handleSendMedia = async (
    mediaUrl: string,
    mediaType: "image" | "video" | "gif",
    caption = "",
  ) => {
    if (mediaCooldown && mediaCooldown > 0) {
      showNotice(
        `Media upload rate limit active. Please wait ${mediaCooldown}s before posting media.`,
      );
      return;
    }

    const targetRoomId = joinedRoomId || "00000000-0000-0000-0000-000000000000";

    if (socket && socketConnected) {
      const payload = {
        roomId: targetRoomId,
        ...(caption.trim() ? { content: caption.trim() } : {}),
        mediaUrl,
        mediaType,
      };

      socket.emit(
        "send_message",
        payload,
        (ack: AckResponse<SendMessageAckData>) => {
          if (ack.ok) return;
          if (ack.error.type === "rate_limited") {
            setMediaCooldown(
              (ack.error.extra?.remainingSeconds as number | undefined) ??
                ack.error.retryAfterSeconds ??
                30,
            );
          } else {
            showNotice((ack.error as any).errors?.[0]?.message || ack.error.detail || ack.error.title || "Your media could not be sent.");
          }
        },
      );
      setMediaCooldown(30);
      setShowGifModal(false);
      setShowMediaModal(false);
      return;
    }

    try {
      setMediaUploading(true);
      await messagesApi.sendMedia(token as string, {
        roomId: targetRoomId,
        mediaUrl,
        mediaType,
        caption: caption.trim() || undefined,
      });
      setMediaCooldown(30);
      setShowGifModal(false);
      setShowMediaModal(false);
    } catch (err) {
      if (err instanceof ApiError) showNotice(err.message);
    } finally {
      setMediaUploading(false);
    }
  };

  // Real file upload -> server returns a URL -> send it through the normal media
  // path above, so a picked file and a pasted URL both end up going through the
  // same moderation/content-control checks on the way to the room.
  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!file || !token) return;

    setMediaUploading(true);
    try {
      const uploaded = await messagesApi.uploadMedia(token, file, joinedRoomId || activeRoomId);
      await handleSendMedia(uploaded.url, uploaded.mediaType, customMediaCaption);
      setCustomMediaCaption("");
    } catch (err) {
      showNotice(err instanceof ApiError ? err.message : "Upload failed");
    } finally {
      setMediaUploading(false);
    }
  };

  // Live GIF search via Giphy's search API. Needs a real API key — Giphy's old
  // widely-shared public "Beta" key (dc6zaTOxFJmzC) now returns 403 BANNED, and
  // Tenor's equally-shared demo key returns 403 "API is discontinued": both of the
  // usual no-signup options are dead, not just rate-limited. Wired against
  // NEXT_PUBLIC_GIPHY_API_KEY so this starts working the moment a real key
  // (free tier at developers.giphy.com) is set — no code change needed then.
  const GIPHY_API_KEY = process.env.NEXT_PUBLIC_GIPHY_API_KEY;
  const TENOR_API_KEY = process.env.NEXT_PUBLIC_TENOR_API_KEY;
  const [gifSearchError, setGifSearchError] = useState<string | null>(null);
  const searchGifs = async (query: string) => {
    const key = gifProvider === "TENOR" ? TENOR_API_KEY : GIPHY_API_KEY;
    if (!key) {
      setGifSearchError(
        gifProvider === "TENOR"
          ? "GIF search needs a Tenor API key (set NEXT_PUBLIC_TENOR_API_KEY) — paste a Tenor GIF URL below instead."
          : "GIF search needs a Giphy API key (set NEXT_PUBLIC_GIPHY_API_KEY) — paste a Giphy GIF URL below instead.",
      );
      setGifSearchResults([]);
      return;
    }
    setGifSearching(true);
    setGifSearchError(null);
    try {
      const q = encodeURIComponent(query.trim());
      let results: Array<{ id: string; url: string; label: string }> = [];
      if (gifProvider === "TENOR") {
        const endpoint = q
          ? `https://tenor.googleapis.com/v2/search?key=${key}&q=${q}&limit=12&contentfilter=medium&media_filter=gif`
          : `https://tenor.googleapis.com/v2/featured?key=${key}&limit=12&contentfilter=medium&media_filter=gif`;
        const json = await (await fetch(endpoint)).json();
        results = (json.results || [])
          .map((g: any) => ({ id: g.id, url: g.media_formats?.gif?.url, label: g.content_description || "GIF" }))
          .filter((g: any) => g.url);
      } else {
        const endpoint = q
          ? `https://api.giphy.com/v1/gifs/search?api_key=${key}&q=${q}&limit=12&rating=pg-13`
          : `https://api.giphy.com/v1/gifs/trending?api_key=${key}&limit=12&rating=pg-13`;
        const json = await (await fetch(endpoint)).json();
        if (json.meta?.status && json.meta.status !== 200) throw new Error(json.meta.msg);
        results = (json.data || [])
          .map((g: any) => ({ id: g.id, url: g.images?.fixed_height?.url || g.images?.original?.url, label: g.title || "GIF" }))
          .filter((g: any) => g.url);
      }
      setGifSearchResults(results);
    } catch {
      setGifSearchError("GIF search failed — paste a GIF URL below instead.");
      setGifSearchResults([]);
    } finally {
      setGifSearching(false);
    }
  };

  useEffect(() => {
    if (showGifModal && gifSearchResults.length === 0 && !gifSearching && !gifSearchError) {
      searchGifs("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showGifModal]);

  // Fetch Mentions Feed
  const fetchMentionsFeed = async () => {
    if (!token) return;
    setLoadingHistory(true);
    setIsViewingMentionsFeed(true);
    setActiveRoomId("tagged-feed");
    setJoinedRoomId(null);
    setUnreadMentionsCount(0);
    setCurrentView("chat");
    try {
      const data = await messagesApi.getMentionsFeed(token, 30);
      setMessages(data.messages || []);
    } catch (err: any) {
    } finally {
      setLoadingHistory(false);
    }
  };

  // Fetch Room Rules (Module 3.1.9)
  const fetchRoomRules = async (roomId?: string) => {
    const targetRoom =
      roomId || activeRoomId || "00000000-0000-0000-0000-000000000000";
    setLoadingRules(true);
    setShowRulesModal(true);
    try {
      const data = await roomsApi.getRoomRules(targetRoom, token);
      setRoomRules(data);
    } catch (err) {
      if (err instanceof ApiError) setRoomRules(null);
    } finally {
      setLoadingRules(false);
    }
  };

  // Loads the cosmetics catalogue silently — needed to render other users'
  // equipped skins in the chat feed even if this viewer never opens the modal.
  const loadCosmeticsList = async () => {
    try {
      const data = await roomsApi.getCosmetics(token);
      setCosmeticsList(Array.isArray(data) ? data : []);
    } catch {}
  };

  // Fetch Chat Cosmetics / Skins (Module 3.1.11)
  const fetchCosmetics = async () => {
    setLoadingCosmetics(true);
    setShowCosmeticsModal(true);
    try {
      await loadCosmeticsList();
    } finally {
      setLoadingCosmetics(false);
    }
  };

  // Equip / Unequip Cosmetic Skin (Module 3.1.11)
  const handleEquipCosmetic = async (cosmeticId: string | null) => {
    setActiveCosmeticId(cosmeticId);
    if (!token) return;
    try {
      const saved = await roomsApi.updatePreferences(token, { activeSkinId: cosmeticId });
      setActiveCosmeticId(saved?.activeSkinId ?? null);
    } catch (err: any) {
      setActiveCosmeticId(null);
      showNotice(err instanceof ApiError ? err.message : "Could not equip this skin");
    }
  };

  // Toggle Anonymous Mode (Module 3.1.12)
  const handleToggleAnonymous = async () => {
    const nextVal = !isAnonymousMode;
    setIsAnonymousMode(nextVal);
    if (token) {
      try {
        await roomsApi.updatePreferences(token, { hideIdentity: nextVal });
      } catch (err: any) {
      }
    }
  };

  const applyAuthenticatedSession = (
    sessionToken: string,
    sessionUser: User,
  ) => {
    setToken(sessionToken);
    setUser(sessionUser);
    localStorage.setItem("orebit_token", sessionToken);
    localStorage.setItem("orebit_user", JSON.stringify(sessionUser));
    setIsAuthModalOpen(false);
    setAuthLoading(false);
    setAuthSuccess(`Welcome, @${sessionUser.username}!`);
    fetchRooms(sessionToken);
  };

  // Handle standard signup
  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError(null);
    setAuthSuccess(null);
    try {
      const session = await authApi.signup(signupForm);
      if (session) {
        applyAuthenticatedSession(session.accessToken, session.user);
        return;
      }
      await handleLoginDirect(signupForm.username, signupForm.password);
    } catch (err) {
      setAuthError(
        err instanceof ApiError ? err.message : `Server signup error: ${(err as Error).message}`,
      );
      setAuthLoading(false);
    }
  };

  // Handle standard login
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    handleLoginDirect(loginForm.usernameOrEmail, loginForm.password);
  };

  const handleLoginDirect = async (usernameOrEmail: string, pass: string) => {
    setAuthLoading(true);
    setAuthError(null);
    setAuthSuccess(null);

    const cleanInput = (usernameOrEmail || "").trim();
    if (!cleanInput || !pass) {
      setAuthError("Username/email and password are required");
      setAuthLoading(false);
      return;
    }

    try {
      const session = (await authApi.login(cleanInput, pass)) ?? (await authApi.currentSession());
      if (session) {
        applyAuthenticatedSession(session.accessToken, session.user);
        return;
      }
      setAuthError("Invalid response from server: Missing session token");
    } catch (err) {
      setAuthError(
        err instanceof ApiError
          ? err.message
          : `Auth server unreachable: ${(err as Error).message}`,
      );
    } finally {
      setAuthLoading(false);
    }
  };

  // Full Frontend Logout implementation
  const handleLogout = () => {
    authApi.logout().catch(() => undefined);
    handleDisconnect();
    setToken(null);
    setUser(null);
    localStorage.removeItem("orebit_token");
    localStorage.removeItem("orebit_user");
    localStorage.removeItem(LAST_ROOM_STORAGE_KEY);
    setMessages([]);
    setRooms([]);
    setJoinedRoomId(null);
    setActiveRoomId("00000000-0000-0000-0000-000000000000");
    setCurrentView("rooms");
  };

  const activeRoom = rooms.find(
    (c) => c.id === activeRoomId || c.slug === activeRoomId,
  );

  // The casino room and the user's casino facts, exactly as the server evaluated them (D-10).
  const casinoRoom = rooms.find((room) => room.type === "CASINO") ?? null;
  const casino = casinoRoom?.casinoConditions ?? null;
  const casinoAutoSwitch = casinoRoom?.casinoAutoSwitch ?? null;

  // "Casino Auto-Switch": the casino facts change while the user plays, so the room list is re-read quietly
  // while the admin has the switch on.
  useEffect(() => {
    if (!token || !casinoAutoSwitch?.enabled) return;
    const timer = window.setInterval(() => {
      void roomsApi
        .getRoomList(token)
        .then(({ items }) =>
          setRooms(
            (Array.isArray(items) ? items : []).filter(
              (r: RoomItem) => r.accessMode !== "LOCKED" && r.isEligibleToView !== false,
            ),
          ),
        )
        .catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [token, casinoAutoSwitch?.enabled]);

  // Switch to the casino room once each time the server starts reporting the user as on the casino; with a DM open
  // only when the admin allows it ("even if DM open"), otherwise when the DM closes.
  const casinoSwitchedRef = useRef(false);
  useEffect(() => {
    if (!casino?.onCasino) {
      casinoSwitchedRef.current = false;
      return;
    }
    if (casinoSwitchedRef.current || !casinoRoom || !casinoAutoSwitch?.enabled) return;
    if (showDmPanel && !casinoAutoSwitch.evenIfDmOpen) return;
    casinoSwitchedRef.current = true;
    if (activeRoomId !== casinoRoom.id && activeRoomId !== casinoRoom.slug) switchRoom(casinoRoom.id, socket, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on the casino facts and the DM panel only
  }, [casino?.onCasino, casinoAutoSwitch?.enabled, casinoAutoSwitch?.evenIfDmOpen, casinoRoom?.id, showDmPanel]);

  const filteredRooms = rooms.filter((room) => {
    // Exclude locked rooms (user is not eligible to view / access denied)
    if (room.accessMode === "LOCKED" || room.isEligibleToView === false) {
      return false;
    }

    let matchesCategory = true;
    if (languageFilter === "EN")
      matchesCategory = Boolean(
        room.language?.includes("EN") || room.slug === "global",
      );
    else if (languageFilter === "ES")
      matchesCategory = Boolean(
        room.language?.includes("ES") || room.slug.includes("spanish"),
      );
    else if (languageFilter === "HI")
      matchesCategory = Boolean(
        room.language?.includes("HI") || room.slug.includes("india"),
      );
    else if (languageFilter === "CONTINENT")
      matchesCategory = Boolean(
        room.type === "REGION" || room.continent !== undefined,
      );

    if (!matchesCategory) return false;

    if (roomSearchQuery.trim()) {
      const q = roomSearchQuery.toLowerCase();
      return (
        room.name.toLowerCase().includes(q) ||
        room.slug.toLowerCase().includes(q) ||
        (room.description && room.description.toLowerCase().includes(q)) ||
        (room.language && room.language.toLowerCase().includes(q)) ||
        (room.continent && room.continent.toLowerCase().includes(q))
      );
    }
    return true;
  });

  return (
    <div className="dashboard-container" suppressHydrationWarning>
      {/* Top Navbar */}
      <header className="top-navbar">
        <div className="nav-brand">
          <div className="brand-badge">OREBiT</div>
        </div>

        <div className="nav-controls">
          {/* Connection Status Pill */}
          <div
            className={`status-pill ${socketConnected ? "connected" : socketConnecting ? "connecting" : "disconnected"}`}
          >
            <span className="status-dot"></span>
            <span>
              {socketConnected
                ? "WS Connected"
                : socketConnecting
                  ? "Connecting..."
                  : "WS Offline"}
            </span>
          </div>

          {token && (
            <button
              onClick={
                socketConnected ? handleDisconnect : () => handleConnectSocket()
              }
              className={`btn btn-sm ${socketConnected ? "btn-danger" : "btn-primary"}`}
            >
              <Wifi size={14} />
              {socketConnected ? "Disconnect" : "Connect Socket"}
            </button>
          )}

          {/* Rooms Directory shortcut button when inside chat */}
          {currentView === "chat" && (
            <button
              onClick={() => setCurrentView("rooms")}
              className="btn btn-sm btn-outline"
              title="Back to All Rooms Directory"
            >
              <ArrowLeft size={14} />
              <span>All Rooms</span>
            </button>
          )}

          {/* Chat Skins Modal Button (Module 3.1.11) */}
          <button
            onClick={fetchCosmetics}
            className="btn btn-sm btn-outline"
            style={{
              borderColor: activeCosmeticId
                ? "rgba(168, 85, 247, 0.6)"
                : "rgba(255, 255, 255, 0.1)",
              color: activeCosmeticId ? "#c084fc" : "#94a3b8",
            }}
            title="Choose Chat Bubble Skin / Cosmetics"
          >
            <Palette size={14} />
            <span>Skins</span>
          </button>

          {/* Direct Messages & Groups (Modules 8 & 9) */}
          <button
            onClick={() => setShowDmPanel(true)}
            className="btn btn-sm btn-outline"
            style={{
              borderColor: "rgba(99, 102, 241, 0.4)",
              color: "#a5b4fc",
            }}
            title="Direct Messages & Group Chats"
          >
            <MessageSquare size={14} />
            <span>DMs & Groups</span>
          </button>

          {/* Advertisements & Promotions (Module 5) */}
          <button
            onClick={() => setShowAdsModal(true)}
            className="btn btn-sm btn-outline"
            style={{
              borderColor: "rgba(236, 72, 153, 0.4)",
              color: "#f472b6",
            }}
            title="Promotions & Ads Feed"
          >
            <Megaphone size={14} />
            <span>Ads</span>
          </button>

          {/* Staff Tools (Module 4): chat ADMIN, MODERATOR and SUPPORT only */}
          {user?.staffRole && (
            <button
              onClick={() => setShowStaffTools(true)}
              className="btn btn-sm btn-outline"
              style={{
                borderColor: "rgba(129, 140, 248, 0.5)",
                color: "#a5b4fc",
              }}
              title="Staff Tools"
              id="staff-tools-button"
            >
              <Shield size={14} />
              <span>Staff Tools</span>
            </button>
          )}

          {/* RainPool (Modules 6–7): the next Rainpool rain, and the panel */}
          <button
            onClick={() => setShowRainPanel(true)}
            className="btn btn-sm btn-outline"
            style={{ borderColor: "rgba(56, 189, 248, 0.4)", color: "#38bdf8" }}
            title={rainSchedule?.nextPotUsd ? `RainPool · ~${rainSchedule.nextPotUsd} USD` : "RainPool"}
            id="rainpool-button"
          >
            <CloudRain size={14} />
            <span>
              {rainSchedule?.systemStatus === "ON" && rainCountdown(rainSchedule.nextRainAt, rainNow)
                ? // The pot counts up until it rains ("filling with time").
                  `${rainSchedule.nextPot ? `${rainApi.rainCountUp(rainSchedule, rainNow)} ${rainSchedule.nextCurrency} · ` : "Rain in "}${rainCountdown(rainSchedule.nextRainAt, rainNow)}`
                : rainSchedule?.systemStatus === "MAINTENANCE"
                  ? "Rain: maintenance"
                  : "RainPool"}
            </span>
          </button>

          {/* Wallet balance per currency (the development wallet until the real ledger is connected) */}
          {walletBalances?.walletConnected && walletBalances.balances.length > 0 && (
            <button
              onClick={() => setShowRainPanel(true)}
              className="btn btn-sm btn-outline"
              style={{ borderColor: "rgba(250, 204, 21, 0.4)", color: "#facc15" }}
              title={`${walletBalances.development ? "Test wallet (development)" : "Wallet"}\n${walletBalances.balances
                .map((b) => `${b.balance} ${b.currency}`)
                .join("\n")}`}
              id="wallet-balance-button"
            >
              <Wallet size={14} />
              <span>
                {walletBalances.balances
                  .slice(0, 2)
                  .map((b) => `${b.balance} ${b.currency}`)
                  .join(" · ")}
                {walletBalances.balances.length > 2 ? ` +${walletBalances.balances.length - 2}` : ""}
              </span>
            </button>
          )}

          {/* Support Chat (Module 10) */}
          <button
            onClick={() => setShowSupportPanel(true)}
            className="btn btn-sm btn-outline"
            style={{
              borderColor: "rgba(56, 189, 248, 0.4)",
              color: "#38bdf8",
            }}
            title="Support Chat"
          >
            <MessageSquare size={14} />
            <span>Support</span>
          </button>

          {/* Privacy & Moderation / Mute-Block List (Module 5) */}
          <button
            onClick={() => setShowMuteBlockPanel(true)}
            className="btn btn-sm btn-outline"
            style={{
              borderColor: "rgba(245, 158, 11, 0.4)",
              color: "#fbbf24",
            }}
            title="Mute & Block List"
          >
            <VolumeX size={14} />
            <span>Moderation</span>
          </button>

          {/* User Profile Pill & Logout Button when logged in */}
          {token || user ? (
            <div className="flex-center gap-2">
              <div
                className="user-profile-pill"
                title={user?.email || "Logged in user"}
              >
                <div className="user-avatar">
                  {user?.username ? user.username.charAt(0).toUpperCase() : "U"}
                </div>
                <span className="user-name-text">
                  @{user?.username || "user"}
                </span>
                {user?.country && (
                  <span className="user-country-tag">{user.country}</span>
                )}
              </div>

              <button
                id="logout-button"
                onClick={handleLogout}
                className="btn btn-sm btn-danger"
                title="Log out and clear session"
              >
                <LogOut size={14} />
                <span>Logout</span>
              </button>
            </div>
          ) : (
            <button
              id="login-button"
              onClick={() => {
                setAuthError(null);
                setIsAuthModalOpen(true);
              }}
              className="btn btn-sm btn-primary"
            >
              <LogIn size={14} />
              <span>Login / Sign Up</span>
            </button>
          )}
        </div>
      </header>

      {/* Dynamic View: Rooms Directory vs In-Place Chat */}
      {currentView === "rooms" ? (
        /* ===== 1. ROOMS LISTING ONLY (LOBBY VIEW) ===== */
        <div className="rooms-lobby-wrapper">
          {/* Lobby Top Section */}
          <div className="rooms-lobby-header">
            {/* Search & Filter Bar */}
            <div className="rooms-search-filter-bar">
              <div className="search-input-wrap">
                <Search size={15} style={{ color: "#94a3b8" }} />
                <input
                  type="text"
                  placeholder="Search rooms by name, slug, language..."
                  value={roomSearchQuery}
                  onChange={(e) => setRoomSearchQuery(e.target.value)}
                />
                {roomSearchQuery && (
                  <button
                    onClick={() => setRoomSearchQuery("")}
                    className="btn-icon"
                    title="Clear Search"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              {/* Language & Continental Filter Bar */}
              <div
                className="language-filter-bar"
                style={{ margin: 0, border: "none", padding: 0 }}
              >
                {[
                  { id: "ALL", label: "All Rooms", icon: null },
                  { id: "EN", label: "English", icon: <Globe size={13} /> },
                  { id: "ES", label: "Español", icon: <Languages size={13} /> },
                  { id: "HI", label: "Hindi", icon: <Languages size={13} /> },
                  {
                    id: "CONTINENT",
                    label: "Continents",
                    icon: <MapPin size={13} />,
                  },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setLanguageFilter(tab.id)}
                    className={`lang-pill-btn ${languageFilter === tab.id ? "active" : ""}`}
                  >
                    {tab.icon && <span>{tab.icon}</span>}
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Featured Bar (Mentions + Casino Simulator) */}
          <div className="lobby-featured-row">
            {/* Tagged & Mentions Card */}
            {token && (
              <div
                onClick={fetchMentionsFeed}
                className="lobby-banner-card mentions-banner-card"
              >
                <div className="flex-between">
                  <div className="flex-center gap-3">
                    <div
                      style={{
                        width: "40px",
                        height: "40px",
                        borderRadius: "8px",
                        background: "rgba(99, 102, 241, 0.2)",
                        border: "1px solid rgba(99, 102, 241, 0.4)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Bell size={20} className="text-indigo-400" />
                    </div>
                    <div>
                      <div
                        style={{
                          fontWeight: 700,
                          color: "#c7d2fe",
                          fontSize: "0.9rem",
                        }}
                      >
                        Tagged & Mentions Feed
                      </div>
                      <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>
                        Messages mentioning @{user?.username || "you"} across
                        all rooms
                      </div>
                    </div>
                  </div>
                  <div className="flex-center gap-2">
                    {unreadMentionsCount > 0 ? (
                      <span className="unread-pill">
                        {unreadMentionsCount} new
                      </span>
                    ) : (
                      <span
                        className="tag-badge"
                        style={{
                          background: "rgba(99, 102, 241, 0.2)",
                          color: "#a5b4fc",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          gap: "4px",
                        }}
                      >
                        <span>View Feed</span>
                        <ArrowRight size={12} />
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Casino status: read-only, from the server (D-10). Nothing here can change it. */}
            {casinoRoom && (
              <div className="lobby-banner-card casino-banner-card">
                <div className="flex-between">
                  <div className="flex-center gap-2">
                    <div
                      style={{
                        width: "38px",
                        height: "38px",
                        borderRadius: "8px",
                        background: "rgba(234, 179, 8, 0.15)",
                        border: "1px solid rgba(234, 179, 8, 0.35)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Dices size={20} className="text-gold" />
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, color: "#fef08a", fontSize: "0.88rem" }}>
                        {casinoRoom.name}
                      </div>
                      <div style={{ fontSize: "0.72rem", color: "#94a3b8", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                        <span className={`status-dot ${casino?.onCasino ? "online" : "offline"}`}></span>
                        <span>{casino?.onCasino ? "On OREBiT Play" : "Not on OREBiT Play"}</span>
                        {casino?.minWagerUsd && (
                          <span>
                            • Wager ${casino.wagerUsd} / ${casino.minWagerUsd} (last {casino.windowDays} days)
                          </span>
                        )}
                        <span>• {casinoRoom.isEligibleToWrite ? "You can chat" : "Read only"}</span>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => switchRoom(casinoRoom.id, socket, true)}
                    className="btn btn-xs btn-outline"
                    title="Open the casino room"
                    style={{ display: "flex", alignItems: "center", gap: "4px" }}
                  >
                    <span>Open</span>
                    <ArrowRight size={12} />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Empty State */}
          {filteredRooms.length === 0 && (
            <div
              className="empty-feed"
              style={{
                padding: "3.5rem 1rem",
                background: "var(--bg-card)",
                borderRadius: "12px",
                border: "1px solid var(--border-color)",
              }}
            >
              <Lock size={36} />
              <p
                style={{
                  fontWeight: 600,
                  marginTop: "0.75rem",
                  fontSize: "1rem",
                }}
              >
                {token
                  ? "No rooms match your filter or search criteria."
                  : "Please log in to view available chat channels."}
              </p>
              {!token && (
                <button
                  onClick={() => setIsAuthModalOpen(true)}
                  className="btn btn-sm btn-primary mt-2"
                >
                  <LogIn size={14} /> Log In / Sign Up
                </button>
              )}
            </div>
          )}

          {/* Rooms Directory Grid */}
          <div className="rooms-grid">
            {filteredRooms.map((room) => {
              return (
                <div
                  key={room.id}
                  onClick={() => switchRoom(room.id, socket, true)}
                  className={`room-lobby-card ${room.accessMode === "VIEW_ONLY" ? "card-view-only" : ""}`}
                >
                  <div className="room-card-header">
                    <div className="room-card-icon-title">
                      <div
                        className={`room-card-icon-badge ${getRoomBadgeClass(room)}`}
                      >
                        {getRoomIcon(room, 20)}
                      </div>
                      <div>
                        <div className="room-card-title">{room.name}</div>
                        <div className="room-card-slug">#{room.slug}</div>
                      </div>
                    </div>

                    <span
                      className={`access-badge badge-${room.accessMode.toLowerCase()}`}
                    >
                      {room.accessMode === "FULL_ACCESS" && (
                        <>
                          <CheckCircle2 size={11} /> Write
                        </>
                      )}
                      {room.accessMode === "VIEW_ONLY" && (
                        <>
                          <Eye size={11} /> View Only
                        </>
                      )}
                    </span>
                  </div>

                  <div className="room-card-body">
                    <p className="room-card-description">
                      {room.description ||
                        "Public real-time discussion channel."}
                    </p>

                    <div className="room-card-tags">
                      {room.language && (
                        <span className="tag-badge tag-language">
                          <Languages size={10} /> {room.language}
                        </span>
                      )}
                      {(room.continent || room.type === "REGION") && (
                        <span className="tag-badge tag-continent">
                          <Globe size={10} />{" "}
                          {room.continent ||
                            (room.slug.includes("asia")
                              ? "Asia"
                              : room.slug.includes("europe")
                                ? "Europe"
                                : room.slug.includes("americas")
                                  ? "Americas"
                                  : "Regional")}
                        </span>
                      )}
                      {room.onlineCount !== undefined && (
                        <span className="tag-badge tag-online">
                          <Users size={10} /> {room.onlineCount} online
                        </span>
                      )}
                    </div>

                    {room.accessMode !== "FULL_ACCESS" && room.reason && (
                      <div
                        className="channel-rule-hint"
                        style={{ marginTop: "0.6rem" }}
                      >
                        <AlertCircle size={12} /> {room.reason}
                      </div>
                    )}
                  </div>

                  <div className="room-card-footer">
                    <span style={{ fontSize: "0.72rem", color: "#64748b" }}>
                      {room.type} Room
                    </span>
                    <div className="room-action-hint">
                      {room.accessMode === "FULL_ACCESS" && (
                        <>
                          <span>Open Chat</span> <ChevronRight size={14} />
                        </>
                      )}
                      {room.accessMode === "VIEW_ONLY" && (
                        <>
                          <span>View Feed</span> <ChevronRight size={14} />
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        /* ===== 2. CHAT BOX VIEW (IN PLACE OF ROOMS LIST) ===== */
        <div className="single-chat-layout">
          <div className="single-chat-card">
            {/* Chat Room Topbar with Back Button */}
            <div className="chat-header">
              <div className="flex-center gap-3">
                <button
                  onClick={() => setCurrentView("rooms")}
                  className="back-to-rooms-btn"
                  title="Back to All Rooms Directory"
                >
                  <ArrowLeft size={16} />
                  <span>All Rooms</span>
                </button>

                <div
                  style={{
                    width: "1px",
                    height: "26px",
                    background: "var(--border-color)",
                  }}
                ></div>

                <div>
                  <div className="flex-center gap-2">
                    <h2
                      className="chat-title"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                      }}
                    >
                      <span className="flex-center">
                        {isViewingMentionsFeed ? (
                          <Bell size={18} className="text-indigo-400" />
                        ) : (
                          getRoomIcon(activeRoom, 18)
                        )}
                      </span>
                      <span>
                        {isViewingMentionsFeed
                          ? "Tagged & Mentions Feed"
                          : activeRoom?.name || "Global Chat Feed"}
                      </span>
                    </h2>
                    {activeRoom && !isViewingMentionsFeed && (
                      <span
                        className={`badge badge-${activeRoom?.accessMode.toLowerCase() || "full_access"}`}
                      >
                        {activeRoom?.accessMode || "FULL_ACCESS"}
                      </span>
                    )}
                  </div>
                  <p className="chat-subtitle">
                    {isViewingMentionsFeed
                      ? `Messages mentioning @${user?.username || "you"} across rooms`
                      : activeRoom?.description ||
                        "Real-time multi-room community discussions"}
                  </p>
                </div>
              </div>

              <div className="chat-actions">
                <button
                  onClick={() => fetchRoomRules(activeRoomId)}
                  className="btn btn-sm btn-outline"
                  title="View Chat Room Rules & Policies (Module 3.1.9)"
                >
                  <BookOpen size={14} />
                  <span>Rules</span>
                </button>

                <button
                  onClick={() => setIsOnlineDrawerOpen(!isOnlineDrawerOpen)}
                  className="online-counter-btn"
                  title="Toggle Active Online Users Drawer"
                >
                  <span className="pulse-dot"></span>
                  <span>{onlineUsers.length} Online</span>
                  <Users size={14} />
                </button>

                <button
                  onClick={() => fetchHistory(activeRoomId)}
                  disabled={loadingHistory || !token}
                  className="btn btn-sm btn-outline"
                >
                  {loadingHistory ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    "Scrollback"
                  )}
                </button>
              </div>
            </div>

            {/* Not Logged In Banner */}
            {!token && (
              <div className="auth-hero-banner">
                <div className="auth-hero-icon">
                  <Shield size={28} />
                </div>
                <h3 className="auth-hero-title">Welcome to OREBiT Social</h3>
                <p className="auth-hero-desc">
                  Sign in or create an account to access real-time chat rooms,
                  view permissions matrix, and send live socket messages.
                </p>
                <button
                  onClick={() => {
                    setAuthError(null);
                    setIsAuthModalOpen(true);
                  }}
                  className="btn btn-primary"
                >
                  <LogIn size={16} /> Sign In / Create Account
                </button>
              </div>
            )}

            {/* Split Feed & Online Drawer Container */}
            <div
              style={{
                display: "flex",
                flex: 1,
                minHeight: 0,
                overflow: "hidden",
                position: "relative",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  flex: 1,
                  minHeight: 0,
                  overflow: "hidden",
                }}
              >
                {/* Locked Warning Banner */}
                {activeRoom?.accessMode === "LOCKED" && (
                  <div
                    className="view-only-banner"
                    style={{
                      background: "rgba(239, 68, 68, 0.15)",
                      borderColor: "rgba(239, 68, 68, 0.4)",
                      color: "#f87171",
                    }}
                  >
                    <Lock size={16} />
                    <span>
                      <b>Access Denied / Room Locked:</b>{" "}
                      {activeRoom.reason ||
                        "You do not have permission to join or view this room."}
                    </span>
                  </div>
                )}

                {/* Promo-only rooms: say what is needed to take part (C-02, CH-092) */}
                {(activeRoom?.accessMode as string) === "PROMO_ONLY" && (
                  <div className="view-only-banner">
                    <Lock size={16} />
                    <span>
                      <b>Promotions only:</b>{" "}
                      {activeRoom?.reason || "You don't meet this room's requirements yet."}
                    </span>
                  </div>
                )}

                {/* Maintenance note set by the admin (CH-091) */}
                {activeRoom?.maintenance?.note && (
                  <div className="view-only-banner">
                    <AlertCircle size={16} />
                    <span>
                      <b>Maintenance:</b> {activeRoom.maintenance.note}
                      {activeRoom.maintenance.until ? ` (until ${new Date(activeRoom.maintenance.until).toLocaleString()})` : ""}
                    </span>
                  </div>
                )}

                {/* View Only Warning Banner */}
                {activeRoom?.accessMode === "VIEW_ONLY" && (
                  <div className="view-only-banner">
                    <Eye size={16} />
                    <span>
                      <b>View-Only Room:</b>{" "}
                      {activeRoom.reason ||
                        "You can read live logs, but sending messages is restricted for your account."}
                    </span>
                  </div>
                )}

                {/* The pinned ad of this room (Module 5) */}
                {pinnedAd && (
                  <div
                    style={{
                      margin: "0 0 0.5rem",
                      padding: "0.55rem 0.8rem",
                      borderRadius: "10px",
                      border: `1px solid ${pinnedAd.skin?.style?.border ?? "rgba(236,72,153,0.45)"}`,
                      background: pinnedAd.skin?.style?.background ?? "rgba(236,72,153,0.08)",
                      fontSize: "0.82rem",
                      color: pinnedAd.skin?.style?.color ?? "#fbcfe8",
                      display: "flex",
                      gap: "0.5rem",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontWeight: 700 }}>
                      📌 {pinnedAd.badge?.emoji ?? ""} {pinnedAd.badge?.text ?? "Sponsored"}
                    </span>
                    <span style={{ flex: 1 }}>{pinnedAd.content}</span>
                  </div>
                )}

                {/* Messages pinned by staff in this room (Module 4) */}
                {pinnedMessages.length > 0 && (
                  <div
                    style={{
                      margin: "0 0 0.5rem",
                      padding: "0.5rem 0.8rem",
                      borderRadius: "10px",
                      border: "1px solid rgba(250,204,21,0.35)",
                      background: "rgba(250,204,21,0.06)",
                      fontSize: "0.8rem",
                      color: "#fde68a",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setShowRoomPinned((v) => !v)}
                      style={{ display: "flex", width: "100%", gap: "0.5rem", alignItems: "center", background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, textAlign: "left" }}
                      title={showRoomPinned ? "Hide pinned messages" : "Show all pinned messages"}
                    >
                      <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>📍 Pinned{pinnedMessages.length > 1 ? ` (${pinnedMessages.length})` : ""}</span>
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {pinnedMessages[0]?.username ? `@${pinnedMessages[0].username}: ` : ""}
                        {pinnedMessages[0]?.content}
                      </span>
                      <ChevronRight size={13} style={{ transform: showRoomPinned ? "rotate(90deg)" : undefined }} />
                    </button>
                    {showRoomPinned && (
                      <div style={{ marginTop: "0.4rem", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                        {pinnedMessages.map((m) => (
                          <div key={m.id} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                            <span style={{ flex: 1, color: "#e2e8f0" }}>
                              {m.username ? <strong>@{m.username}: </strong> : null}
                              {m.content}
                            </span>
                            {staffFlags?.canPin && (
                              <button type="button" className="btn-icon-xs" onClick={() => void handleTogglePin({ ...m, isPinned: true })} title="Unpin">
                                <X size={11} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Message Feed */}
                <ChatMessageList
                  messages={messages}
                  activeRoom={activeRoom}
                  token={token}
                  currentUser={user}
                  cosmetics={cosmeticsList}
                  feedEndRef={chatFeedEndRef}
                  onMentionAuthor={(username) => openProfile(username)}
                  onRetractMessage={handleRetractMessage}
                  onReportMessage={(msg) => {
                    setReportingMessage(msg);
                    setShowReportModal(true);
                  }}
                  staff={staffFlags}
                  onTogglePin={(msg) => void handleTogglePin(msg)}
                />

                {commandOutput && (
                  <CommandResultCard output={commandOutput} onClose={() => setCommandOutput(null)} />
                )}

                {/* Chat Input Form */}
                <form onSubmit={handleSendMessage} className="message-form">
                  {/* Reactions Dropdown (Clean SVG Icons) */}
                  {showEmojiPicker && (
                    <div className="emoji-picker-dropdown">
                      <div className="emoji-picker-header">
                        <span>Quick Reactions</span>
                        <button
                          type="button"
                          onClick={() => setShowEmojiPicker(false)}
                          className="btn-icon"
                        >
                          <X size={12} />
                        </button>
                      </div>
                      <div className="emoji-grid-clean">
                        {[
                          { label: "Like", icon: ThumbsUp, code: "👍" },
                          { label: "Love", icon: Heart, code: "❤️" },
                          { label: "Fire", icon: Flame, code: "🔥" },
                          { label: "GG", icon: Sparkles, code: "🎉" },
                          { label: "Win", icon: Trophy, code: "🏆" },
                          { label: "Star", icon: Star, code: "⭐" },
                          { label: "100", icon: Check, code: "💯" },
                          {
                            label: "Alert",
                            icon: AlertCircle,
                            code: "🚨",
                          },
                        ].map((rx) => {
                          const IconComp = rx.icon;
                          return (
                            <button
                              key={rx.code}
                              type="button"
                              onClick={() => handleInsertEmoji(rx.code)}
                              className="reaction-picker-btn"
                              title={rx.label}
                            >
                              <IconComp size={16} />
                              <span>{rx.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Module 3: Quick Media / Emoji Action Buttons */}
                  <div className="input-action-buttons">
                    <button
                      type="button"
                      onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                      className="input-action-btn"
                      title="Insert quick reaction"
                      disabled={!socketConnected || Boolean(rateLimitCooldown)}
                    >
                      <Smile size={17} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowGifModal(true)}
                      className="input-action-btn"
                      title="Send GIF reaction"
                      disabled={
                        !socketConnected ||
                        Boolean(mediaCooldown) ||
                        Boolean(rateLimitCooldown)
                      }
                    >
                      <Film size={17} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowMediaModal(true)}
                      className="input-action-btn"
                      title="Attach Image / Video"
                      disabled={
                        !socketConnected ||
                        Boolean(mediaCooldown) ||
                        Boolean(rateLimitCooldown)
                      }
                    >
                      <ImageIcon size={17} />
                      {mediaCooldown && mediaCooldown > 0 && (
                        <span className="media-badge-cooldown">
                          {mediaCooldown}s
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowGiftModal(true)}
                      className="input-action-btn"
                      title="Send Gift / Tip to user"
                      disabled={!socketConnected || Boolean(rateLimitCooldown)}
                    >
                      <Gift size={17} />
                    </button>
                  </div>

                  {/* Module 5: Slash Command Suggestions Autocomplete */}
                  {messageText.trimStart().startsWith("/") && (
                    <div style={{ position: "relative", width: "100%" }}>
                      <CommandSuggestions
                        inputText={messageText}
                        highlightedIndex={commandHighlightedIndex}
                        onSelect={(cmd) => {
                          setMessageText(cmd.usage + " ");
                        }}
                      />
                    </div>
                  )}

                  <input
                    type="text"
                    value={messageText}
                    onChange={handleInputChange}
                    disabled={
                      !socketConnected ||
                      activeRoom?.accessMode === "VIEW_ONLY" ||
                      activeRoom?.accessMode === "LOCKED" ||
                      activeRoom?.isEligibleToWrite === false ||
                      Boolean(rateLimitCooldown)
                    }
                    placeholder={
                      rateLimitCooldown
                        ? `Anti-spam cooldown active (${rateLimitCooldown}s remaining)...`
                        : !token
                          ? "Log in above to participate in live chat..."
                          : activeRoom?.accessMode === "LOCKED" ||
                              activeRoom?.isEligibleToView === false
                            ? `Locked Room (${activeRoom?.reason || "Access Denied"})`
                            : activeRoom?.accessMode === "VIEW_ONLY"
                              ? `View-Only Mode (${activeRoom.reason || "Restricted"})`
                              : socketConnected
                                ? `Message #${isViewingMentionsFeed ? "mentions" : activeRoom?.name || "room"}...`
                                : "Connect WebSocket to start chatting..."
                    }
                    className="message-input"
                  />
                  <button
                    type="submit"
                    disabled={
                      !socketConnected ||
                      !messageText.trim() ||
                      activeRoom?.accessMode === "VIEW_ONLY" ||
                      activeRoom?.accessMode === "LOCKED" ||
                      activeRoom?.isEligibleToWrite === false ||
                      Boolean(rateLimitCooldown)
                    }
                    className="btn btn-primary send-btn"
                  >
                    <Send size={16} />
                  </button>
                </form>
              </div>

              {/* Active Online Users Sidebar Drawer */}
              {isOnlineDrawerOpen && (
                <aside className="online-drawer-panel">
                  <div className="online-drawer-header">
                    <div className="online-drawer-title">
                      <Users size={15} className="text-gold" />
                      <span>Online ({onlineUsers.length})</span>
                    </div>
                    <button
                      onClick={() => setIsOnlineDrawerOpen(false)}
                      className="btn-icon"
                      title="Hide online users"
                    >
                      <X size={14} />
                    </button>
                  </div>

                  <div className="online-users-list">
                    {onlineUsers.length === 0 ? (
                      <div
                        style={{
                          padding: "1.5rem 0.5rem",
                          textAlign: "center",
                          color: "#64748b",
                          fontSize: "0.75rem",
                        }}
                      >
                        No other users online
                      </div>
                    ) : (
                      onlineUsers.map((u) => {
                        const isCurrent = user?.id === u.id;
                        return (
                          <div
                            key={u.id}
                            className="online-user-card"
                            onClick={() => openProfile(u.username)}
                            title={`Open @${u.username}'s profile`}
                          >
                            <div className="online-user-avatar-wrap">
                              <div className="online-user-avatar">
                                {u.username.charAt(0).toUpperCase()}
                              </div>
                              <span className="online-dot-badge"></span>
                            </div>
                            <div className="online-user-info">
                              <div className="online-user-name-row">
                                <span className="online-user-name">
                                  @{u.username} {isCurrent && "(You)"}
                                </span>
                                {u.country && (
                                  <span className="country-tag-mini">
                                    {u.country}
                                  </span>
                                )}
                              </div>
                              <div className="online-user-badges">
                                {u.isStaff && (
                                  <span className="role-tag-mini role-tag-staff">STAFF</span>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </aside>
              )}
            </div>
          </div>
        </div>
      )}

      {notice && (
        <div
          role="status"
          onClick={() => setNotice(null)}
          style={{
            position: "fixed",
            top: 16,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 2000,
            maxWidth: "min(560px, calc(100vw - 32px))",
            padding: "10px 16px",
            borderRadius: 10,
            cursor: "pointer",
            background: notice.kind === "error" ? "rgba(127, 29, 29, 0.95)" : "rgba(6, 78, 59, 0.95)",
            color: "#fff",
            fontSize: "0.85rem",
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
          }}
        >
          {notice.text}
        </div>
      )}

      {profileCard && (
        <div className="modal-overlay" onClick={() => setProfileCard(null)}>
          <div className="modal-dialog" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 style={{ margin: 0 }}>@{profileCard.username}</h3>
              <button className="modal-close" onClick={() => setProfileCard(null)} aria-label="Close profile">
                <X size={16} />
              </button>
            </div>
            <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6, fontSize: "0.85rem" }}>
              <div>{profileCard.isOnline ? "🟢 Online" : `⚪ Last online: ${profileCard.lastSeenAt ? new Date(profileCard.lastSeenAt).toLocaleString() : "—"}`}</div>
              {profileCard.country && <div>Country: {profileCard.country}</div>}
              {profileCard.isStaff && <div>Chat staff</div>}
              {profileCard.badges?.premium && <div>Premium</div>}
              {profileCard.badges?.kycVerified && <div>KYC verified</div>}
              {profileCard.publicCode && <div>User ID: <b>{profileCard.publicCode}</b></div>}
              <div>Member since: {new Date(profileCard.memberSince).toLocaleDateString()}</div>
            </div>
            <div style={{ display: "flex", gap: 8, padding: "0 16px 16px" }}>
              <button
                className="btn btn-outline btn-xs"
                onClick={() => {
                  setMessageText((prev) => `${prev}@${profileCard.username} `);
                  setProfileCard(null);
                }}
              >
                Mention
              </button>
              {user?.username !== profileCard.username && (
                <button
                  className="btn btn-outline btn-xs"
                  onClick={() => {
                    setReportingMessage(null);
                    setReportingUser({ id: profileCard.id, username: profileCard.username });
                    setProfileCard(null);
                    setShowReportModal(true);
                  }}
                >
                  Report user
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Authentication Modal */}
      {isAuthModalOpen && (
        <div
          className="modal-overlay"
          onClick={() => setIsAuthModalOpen(false)}
        >
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>
                <Key size={18} className="text-gold" />
                <span>Account Authentication</span>
              </h2>
              <button
                onClick={() => setIsAuthModalOpen(false)}
                className="btn-icon"
              >
                <X size={16} />
              </button>
            </div>

            <div className="modal-tabs">
              <button
                className={`modal-tab-btn ${authTab === "login" ? "active" : ""}`}
                onClick={() => {
                  setAuthTab("login");
                  setAuthError(null);
                }}
              >
                <LogIn size={14} /> Sign In
              </button>
              <button
                className={`modal-tab-btn ${authTab === "signup" ? "active" : ""}`}
                onClick={() => {
                  setAuthTab("signup");
                  setAuthError(null);
                }}
              >
                <UserPlus size={14} /> Register
              </button>
            </div>

            <div className="modal-body">
              {authError && (
                <div className="auth-error-banner">
                  <AlertCircle size={14} />
                  <span>{authError}</span>
                </div>
              )}

              {/* Login Tab */}
              {authTab === "login" && (
                <form onSubmit={handleLogin} className="auth-form">
                  <div className="form-group">
                    <label className="form-label">Username or Email</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="e.g. testuser1 or test@example.com"
                      value={loginForm.usernameOrEmail}
                      onChange={(e) =>
                        setLoginForm((prev) => ({
                          ...prev,
                          usernameOrEmail: e.target.value,
                        }))
                      }
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Password</label>
                    <input
                      type="password"
                      className="form-input"
                      placeholder="••••••••"
                      value={loginForm.password}
                      onChange={(e) =>
                        setLoginForm((prev) => ({
                          ...prev,
                          password: e.target.value,
                        }))
                      }
                      required
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={
                      authLoading ||
                      !loginForm.usernameOrEmail ||
                      !loginForm.password
                    }
                    className="btn btn-primary"
                    style={{ marginTop: "0.5rem", justifyContent: "center" }}
                  >
                    {authLoading ? (
                      <Loader2 size={16} className="spin" />
                    ) : (
                      <LogIn size={16} />
                    )}
                    <span>{authLoading ? "Signing In..." : "Sign In"}</span>
                  </button>
                </form>
              )}

              {/* Signup Tab */}
              {authTab === "signup" && (
                <form onSubmit={handleSignup} className="auth-form">
                  <div className="form-group">
                    <label className="form-label">Username</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="unique_username"
                      value={signupForm.username}
                      onChange={(e) =>
                        setSignupForm((prev) => ({
                          ...prev,
                          username: e.target.value,
                        }))
                      }
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Email</label>
                    <input
                      type="email"
                      className="form-input"
                      placeholder="name@example.com"
                      value={signupForm.email}
                      onChange={(e) =>
                        setSignupForm((prev) => ({
                          ...prev,
                          email: e.target.value,
                        }))
                      }
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Password</label>
                    <input
                      type="password"
                      className="form-input"
                      placeholder="••••••••"
                      value={signupForm.password}
                      onChange={(e) =>
                        setSignupForm((prev) => ({
                          ...prev,
                          password: e.target.value,
                        }))
                      }
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Country Code</label>
                    <select
                      className="form-select"
                      value={signupForm.country}
                      onChange={(e) =>
                        setSignupForm((prev) => ({
                          ...prev,
                          country: e.target.value,
                        }))
                      }
                    >
                      <option value="IN">India (IN)</option>
                      <option value="US">United States (US)</option>
                      <option value="ES">Spain (ES)</option>
                      <option value="GB">United Kingdom (GB)</option>
                    </select>
                  </div>

                  <button
                    type="submit"
                    disabled={
                      authLoading ||
                      !signupForm.username ||
                      !signupForm.email ||
                      !signupForm.password
                    }
                    className="btn btn-primary"
                    style={{ marginTop: "0.5rem", justifyContent: "center" }}
                  >
                    {authLoading ? (
                      <Loader2 size={16} className="spin" />
                    ) : (
                      <UserPlus size={16} />
                    )}
                    <span>
                      {authLoading ? "Creating Account..." : "Create Account"}
                    </span>
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Module 3: GIF Selection Modal */}
      {showGifModal && (
        <div className="modal-backdrop" onClick={() => setShowGifModal(false)}>
          <div
            className="modal-dialog"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "520px" }}
          >
            <div className="modal-header">
              <h2>
                <Film size={18} className="text-gold" /> Send a GIF Reaction
              </h2>
              <button
                onClick={() => setShowGifModal(false)}
                className="btn-icon"
              >
                <X size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>
                {`Search ${gifProvider === "TENOR" ? "Tenor" : "Giphy"} for a GIF, or paste a ${gifProvider === "TENOR" ? "Tenor" : "Giphy"} GIF link below:`}
              </div>

              {/* Live GIF search */}
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <input
                  type="text"
                  placeholder="Search GIFs…"
                  value={gifSearchQuery}
                  onChange={(e) => setGifSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") searchGifs(gifSearchQuery);
                  }}
                  className="form-input"
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={gifSearching}
                  onClick={() => searchGifs(gifSearchQuery)}
                >
                  {gifSearching ? "Searching…" : "Search"}
                </button>
              </div>

              {/* Live search results */}
              {gifSearchError ? (
                <div
                  style={{
                    fontSize: "0.75rem",
                    color: "#fcd34d",
                    background: "rgba(245, 158, 11, 0.1)",
                    border: "1px solid rgba(245, 158, 11, 0.3)",
                    borderRadius: "6px",
                    padding: "0.5rem",
                  }}
                >
                  {gifSearchError}
                </div>
              ) : (
                <div className="gif-grid">
                  {gifSearchResults.map((item) => (
                    <div
                      key={item.id}
                      className="gif-card"
                      onClick={() => handleSendMedia(item.url, "gif", item.label)}
                    >
                      <img src={item.url} alt={item.label} loading="lazy" />
                      <span className="gif-card-label">{item.label}</span>
                    </div>
                  ))}
                  {!gifSearching && gifSearchResults.length === 0 && (
                    <div style={{ fontSize: "0.75rem", color: "#94a3b8", padding: "0.5rem" }}>
                      No results. Try a different search term.
                    </div>
                  )}
                </div>
              )}

              {/* Custom GIF URL Form */}
              <div
                style={{
                  borderTop: "1px solid #334155",
                  paddingTop: "0.75rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.5rem",
                }}
              >
                <span
                  style={{
                    fontSize: "0.75rem",
                    fontWeight: 700,
                    color: "#cbd5e1",
                  }}
                >
                  Or Custom GIF URL:
                </span>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <input
                    type="url"
                    placeholder={gifProvider === "TENOR" ? "https://media.tenor.com/.../tenor.gif" : "https://media.giphy.com/.../giphy.gif"}
                    value={customMediaUrl}
                    onChange={(e) => setCustomMediaUrl(e.target.value)}
                    className="form-input"
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    disabled={!customMediaUrl.trim()}
                    onClick={() => {
                      if (customMediaUrl.trim()) {
                        handleSendMedia(customMediaUrl.trim(), "gif");
                        setCustomMediaUrl("");
                      }
                    }}
                    className="btn btn-primary"
                  >
                    Send
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Module 3: Media Upload Modal (Images / Videos) */}
      {showMediaModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowMediaModal(false)}
        >
          <div
            className="modal-dialog"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "480px" }}
          >
            <div className="modal-header">
              <h2>
                <ImageIcon size={18} className="text-gold" /> Share Media (Image
                / Video)
              </h2>
              <button
                onClick={() => setShowMediaModal(false)}
                className="btn-icon"
              >
                <X size={16} />
              </button>
            </div>

            <div className="modal-body">
              {/* Media rate limit note */}
              <div
                style={{
                  background: "rgba(245, 158, 11, 0.1)",
                  border: "1px solid rgba(245, 158, 11, 0.3)",
                  borderRadius: "6px",
                  padding: "0.5rem",
                  fontSize: "0.72rem",
                  color: "#fcd34d",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.4rem",
                }}
              >
                <Clock size={13} />
                <span>
                  <b>Media Rate Limit:</b> Cooldown is 30s per user between
                  media uploads.
                </span>
              </div>

              {/* Media Format Selector */}
              <div className="form-group">
                <label className="form-label">Media Type</label>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    type="button"
                    onClick={() => setCustomMediaType("image")}
                    className={`btn btn-xs ${customMediaType === "image" ? "btn-primary" : "btn-outline"}`}
                    style={{
                      flex: 1,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "4px",
                    }}
                  >
                    <ImageIcon size={13} />
                    <span>Image</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setCustomMediaType("video")}
                    className={`btn btn-xs ${customMediaType === "video" ? "btn-primary" : "btn-outline"}`}
                    style={{
                      flex: 1,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "4px",
                    }}
                  >
                    <Film size={13} />
                    <span>Video</span>
                  </button>
                </div>
              </div>

              {/* File upload — real multipart upload to the server, not a URL paste */}
              <div className="form-group">
                <label className="form-label">Upload a file (max 10MB)</label>
                <input
                  type="file"
                  accept={customMediaType === "video" ? "video/mp4,video/webm" : "image/png,image/jpeg,image/webp,image/gif"}
                  onChange={handleFileSelected}
                  disabled={mediaUploading}
                  className="form-input"
                />
                {mediaUploading && (
                  <span style={{ fontSize: "0.72rem", color: "#94a3b8" }}>Uploading…</span>
                )}
              </div>

              {/* Media URL Input */}
              <div className="form-group">
                <label className="form-label">Or paste a direct media URL</label>
                <input
                  type="url"
                  placeholder="Paste a GIF link from the provider the admin chose"
                  value={customMediaUrl}
                  onChange={(e) => setCustomMediaUrl(e.target.value)}
                  className="form-input"
                />
              </div>

              {/* Caption Input */}
              <div className="form-group">
                <label className="form-label">Optional Caption</label>
                <input
                  type="text"
                  placeholder="Check this out!"
                  value={customMediaCaption}
                  onChange={(e) => setCustomMediaCaption(e.target.value)}
                  className="form-input"
                />
              </div>

              <button
                type="button"
                disabled={mediaUploading || !customMediaUrl.trim()}
                onClick={() => {
                  if (customMediaUrl.trim()) {
                    handleSendMedia(
                      customMediaUrl.trim(),
                      customMediaType,
                      customMediaCaption,
                    );
                    setCustomMediaUrl("");
                    setCustomMediaCaption("");
                  }
                }}
                className="btn btn-primary"
                style={{ marginTop: "0.5rem", justifyContent: "center" }}
              >
                {mediaUploading ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <Send size={16} />
                )}
                <span>
                  Send {customMediaType === "video" ? "Video" : "Image"}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Module 3: In-Chat Message Report Modal */}
      {showReportModal && (reportingMessage || reportingUser) && (
        <div
          className="modal-backdrop"
          onClick={() => setShowReportModal(false)}
        >
          <div
            className="modal-dialog"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "440px" }}
          >
            <div className="modal-header">
              <h2>
                <Flag size={18} className="text-amber" /> Report Content
              </h2>
              <button
                onClick={() => setShowReportModal(false)}
                className="btn-icon"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleSubmitReport} className="modal-body">
              {/* Message preview snippet */}
              <div
                style={{
                  background: "#0f172a",
                  border: "1px solid #334155",
                  borderRadius: "6px",
                  padding: "0.65rem",
                  fontSize: "0.75rem",
                }}
              >
                <span style={{ color: "#94a3b8" }}>
                  {reportingMessage ? (
                    <>Reporting message from <b>@{reportingMessage.username ?? "unknown"}</b>:</>
                  ) : (
                    <>Reporting user <b>@{reportingUser?.username}</b></>
                  )}
                </span>
                <p
                  style={{
                    color: "#f1f5f9",
                    marginTop: "0.25rem",
                    fontStyle: "italic",
                  }}
                >
                  "
                  {(reportingMessage?.content ?? "").length > 80
                    ? (reportingMessage?.content ?? "").substring(0, 80) + "..."
                    : (reportingMessage?.content ?? "")}
                  "
                </p>
              </div>

              <div className="form-group">
                <label className="form-label">Violation Category</label>
                <select
                  className="form-select"
                  value={reportForm.reason}
                  onChange={(e) =>
                    setReportForm((prev) => ({
                      ...prev,
                      reason: e.target.value,
                    }))
                  }
                  required
                >
                  {reportReasons.length === 0 && <option value="">Loading reasons…</option>}
                  {reportReasons.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">
                  Additional Details (Optional)
                </label>
                <textarea
                  className="form-input"
                  rows={3}
                  placeholder="Provide context for moderation staff..."
                  value={reportForm.details}
                  onChange={(e) =>
                    setReportForm((prev) => ({
                      ...prev,
                      details: e.target.value,
                    }))
                  }
                />
              </div>

              <button
                type="submit"
                disabled={reportSubmitting}
                className="btn btn-primary"
                style={{
                  justifyContent: "center",
                  background: "#dc2626",
                  borderColor: "#b91c1c",
                }}
              >
                {reportSubmitting ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <Flag size={16} />
                )}
                <span>Submit Report to Moderators</span>
              </button>
            </form>
          </div>
        </div>
      )}
      {/* Module 3.1.9: Room Rules Modal */}
      {showRulesModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowRulesModal(false)}
        >
          <div
            className="modal-dialog"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "520px" }}
          >
            <div className="modal-header">
              <h2>
                <BookOpen size={18} className="text-cyan" /> Room Rules &
                Policies
              </h2>
              <button
                onClick={() => setShowRulesModal(false)}
                className="btn-icon"
              >
                <X size={16} />
              </button>
            </div>

            <div className="modal-body">
              {loadingRules ? (
                <div
                  style={{
                    padding: "2rem",
                    textAlign: "center",
                    color: "#94a3b8",
                  }}
                >
                  <Loader2
                    size={24}
                    className="spin"
                    style={{ margin: "0 auto 0.5rem" }}
                  />
                  <p>Fetching official room guidelines...</p>
                </div>
              ) : roomRules ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "1rem",
                  }}
                >
                  <div
                    style={{
                      background: "#0b101b",
                      border: "1px solid #1e293b",
                      borderRadius: "8px",
                      padding: "0.85rem",
                    }}
                  >
                    <h3
                      style={{
                        fontSize: "0.95rem",
                        color: "#f8fafc",
                        fontWeight: 600,
                      }}
                    >
                      {roomRules.roomName || "Community Room"}
                    </h3>
                    <p
                      style={{
                        fontSize: "0.75rem",
                        color: "#94a3b8",
                        marginTop: "0.2rem",
                      }}
                    >
                      Room ID: <code>{roomRules.roomId}</code>
                    </p>
                  </div>

                  <div>
                    <h4
                      style={{
                        fontSize: "0.8rem",
                        color: "#94a3b8",
                        textTransform: "uppercase",
                        marginBottom: "0.5rem",
                        fontWeight: 600,
                      }}
                    >
                      Content Permissions
                    </h4>
                    <div
                      style={{
                        display: "flex",
                        gap: "0.5rem",
                        flexWrap: "wrap",
                      }}
                    >
                      <span className="rules-chip flex-center gap-1.5">
                        <Check size={12} className="text-emerald-400" /> Text
                        Messages
                      </span>
                      <span className="rules-chip flex-center gap-1.5">
                        <Check size={12} className="text-emerald-400" />{" "}
                        Reactions & Media
                      </span>
                      <span className="rules-chip flex-center gap-1.5">
                        <Check size={12} className="text-emerald-400" /> Rate
                        Limits Active
                      </span>
                      <span className="rules-chip flex-center gap-1.5">
                        <Shield size={12} className="text-amber-400" />{" "}
                        Auto-Moderation Active
                      </span>
                    </div>
                  </div>

                  <div>
                    <h4
                      style={{
                        fontSize: "0.8rem",
                        color: "#94a3b8",
                        textTransform: "uppercase",
                        marginBottom: "0.5rem",
                        fontWeight: 600,
                      }}
                    >
                      Community Guidelines
                    </h4>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.5rem",
                      }}
                    >
                      {Array.isArray(roomRules.rules) &&
                      roomRules.rules.length > 0 ? (
                        roomRules.rules.map((rule: string, idx: number) => (
                          <div
                            key={idx}
                            style={{
                              background: "rgba(255, 255, 255, 0.02)",
                              border: "1px solid #1e293b",
                              borderRadius: "6px",
                              padding: "0.6rem 0.8rem",
                              fontSize: "0.8rem",
                              color: "#e2e8f0",
                            }}
                          >
                            <b>#{idx + 1}</b> {rule}
                          </div>
                        ))
                      ) : (
                        <div
                          style={{
                            background: "rgba(255, 255, 255, 0.02)",
                            border: "1px solid #1e293b",
                            borderRadius: "6px",
                            padding: "0.75rem",
                            fontSize: "0.8rem",
                            color: "#94a3b8",
                          }}
                        >
                          Standard platform etiquette applies. Be respectful, no
                          spam or solicitation, and follow moderator
                          instructions.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    padding: "1.5rem",
                    textAlign: "center",
                    color: "#94a3b8",
                  }}
                >
                  <p>Standard OREBiT community rules apply to this room.</p>
                </div>
              )}

              <button
                type="button"
                onClick={() => setShowRulesModal(false)}
                className="btn btn-outline"
                style={{
                  width: "100%",
                  justifyContent: "center",
                  marginTop: "0.75rem",
                }}
              >
                Close Guidelines
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Module 3.1.11: Chat Cosmetics & Skins Modal */}
      {showCosmeticsModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowCosmeticsModal(false)}
        >
          <div
            className="modal-dialog"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "580px" }}
          >
            <div className="modal-header">
              <h2>
                <Palette size={18} className="text-purple" /> Chat Bubble Skins
                & Themes
              </h2>
              <button
                onClick={() => setShowCosmeticsModal(false)}
                className="btn-icon"
              >
                <X size={16} />
              </button>
            </div>

            <div className="modal-body">
              <p
                style={{
                  fontSize: "0.8rem",
                  color: "#94a3b8",
                  marginBottom: "1rem",
                }}
              >
                Equip premium animated bubble skins and glowing effects for your
                live messages across all public rooms.
              </p>

              {loadingCosmetics ? (
                <div
                  style={{
                    padding: "2rem",
                    textAlign: "center",
                    color: "#94a3b8",
                  }}
                >
                  <Loader2
                    size={24}
                    className="spin"
                    style={{ margin: "0 auto 0.5rem" }}
                  />
                  <p>Loading available cosmetic themes...</p>
                </div>
              ) : (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.75rem",
                  }}
                >
                  {/* Default / None Option */}
                  <div
                    style={{
                      background: !activeCosmeticId
                        ? "rgba(99, 102, 241, 0.15)"
                        : "rgba(255, 255, 255, 0.02)",
                      border: !activeCosmeticId
                        ? "1px solid #6366f1"
                        : "1px solid #1e293b",
                      borderRadius: "8px",
                      padding: "0.75rem 1rem",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      cursor: "pointer",
                    }}
                    onClick={() => handleEquipCosmetic(null)}
                  >
                    <div>
                      <h4
                        style={{
                          fontSize: "0.85rem",
                          color: "#f8fafc",
                          fontWeight: 600,
                        }}
                      >
                        Default Slate Bubble
                      </h4>
                      <span style={{ fontSize: "0.72rem", color: "#94a3b8" }}>
                        Standard clean dark theme appearance
                      </span>
                    </div>
                    <button
                      className={`btn btn-sm ${!activeCosmeticId ? "btn-primary" : "btn-outline"}`}
                    >
                      {!activeCosmeticId ? (
                        <span className="flex-center gap-1">
                          <Check size={12} /> Equipped
                        </span>
                      ) : (
                        "Equip"
                      )}
                    </button>
                  </div>

                  {cosmeticsList.map((item) => {
                    const isEquipped = activeCosmeticId === item.id;
                    const badge = item.style?.badge || "SKIN";
                    return (
                      <div
                        key={item.id}
                        style={{
                          background: isEquipped
                            ? "rgba(168, 85, 247, 0.15)"
                            : "rgba(255, 255, 255, 0.02)",
                          border: isEquipped
                            ? "1px solid #a855f7"
                            : "1px solid #1e293b",
                          borderRadius: "8px",
                          padding: "0.75rem 1rem",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          cursor: "pointer",
                        }}
                        onClick={() => handleEquipCosmetic(item.id)}
                      >
                        <div>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.5rem",
                            }}
                          >
                            <h4
                              style={{
                                fontSize: "0.85rem",
                                color: item.style?.textColor || "#f8fafc",
                                fontWeight: 600,
                              }}
                            >
                              {item.name}
                            </h4>
                            <span
                              style={{
                                fontSize: "0.65rem",
                                background: "rgba(255, 255, 255, 0.08)",
                                padding: "0.15rem 0.4rem",
                                borderRadius: "4px",
                                color: item.style?.textColor || "#94a3b8",
                              }}
                            >
                              {badge}
                            </span>
                          </div>
                          <span
                            style={{ fontSize: "0.72rem", color: "#94a3b8" }}
                          >
                            {item.type || "BUBBLE_GLOW"}
                          </span>
                        </div>
                        <button
                          className={`btn btn-sm ${isEquipped ? "btn-primary" : "btn-outline"}`}
                          style={
                            isEquipped
                              ? {
                                  background: "#a855f7",
                                  borderColor: "#a855f7",
                                }
                              : {}
                          }
                        >
                          {isEquipped ? (
                            <span className="flex-center gap-1">
                              <Check size={12} /> Equipped
                            </span>
                          ) : (
                            "Equip Skin"
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              <button
                type="button"
                onClick={() => setShowCosmeticsModal(false)}
                className="btn btn-outline"
                style={{
                  width: "100%",
                  justifyContent: "center",
                  marginTop: "1rem",
                }}
              >
                Close Skins Studio
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DM & Groups Panel Modal (Modules 8 & 9) */}
      {showDmPanel && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9990,
            background: "rgba(0, 0, 0, 0.8)",
            backdropFilter: "blur(8px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowDmPanel(false);
              setDmOpenConversationId(undefined);
            }
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: "1080px",
              height: "88vh",
              borderRadius: "16px",
              overflow: "hidden",
              border: "1px solid rgba(255, 255, 255, 0.12)",
              boxShadow: "0 25px 80px rgba(0, 0, 0, 0.7)",
            }}
          >
            <DmPanel
              currentUser={user}
              socket={socket}
              initialConversationId={dmOpenConversationId}
              onClose={() => {
                setShowDmPanel(false);
                setDmOpenConversationId(undefined);
              }}
            />
          </div>
        </div>
      )}

      {/* Ads & Promotions Modal (Module 5) */}
      {showAdsModal && (
        <MyAdsModal
          roomId={activeRoom?.id}
          onClose={() => setShowAdsModal(false)}
        />
      )}

      {/* Mute & Block List Panel (Module 5) */}
      {showSupportPanel && (
        <SupportPanel socket={socket} onClose={() => setShowSupportPanel(false)} />
      )}

      {showMuteBlockPanel && (
        <MuteBlockPanel onClose={() => setShowMuteBlockPanel(false)} />
      )}

      {/* RainPool panel and the verification of a /rain (Modules 6–7) */}
      {showRainPanel && (
        <RainPoolPanel
          refreshKey={rainRefreshKey}
          roomName={(id) => rooms.find((r) => r.id === id)?.name ?? "a room"}
          onContinue={(p) => {
            setShowRainPanel(false);
            setPendingRain(p);
          }}
          onClose={() => setShowRainPanel(false)}
        />
      )}
      {pendingRain && (
        <RainVerifyModal
          pending={pendingRain}
          onClose={() => setPendingRain(null)}
          onDone={(result) => {
            setPendingRain(null);
            setRainRefreshKey((k) => k + 1);
            handleCommandResult("rain", result);
          }}
        />
      )}
      {/* Gift Modal (Module 5) */}
      {showGiftModal && (
        <GiftModal
          roomId={activeRoomId || undefined}
          onClose={() => setShowGiftModal(false)}
        />
      )}
      {/* "/send @user amount CURRENCY" typed in chat: the PIN / 2FA step */}
      {pendingGift && (
        <GiftModal pending={pendingGift} roomId={activeRoomId || undefined} onClose={() => setPendingGift(null)} />
      )}

      {/* Staff Tools (Module 4) */}
      {showStaffTools && (
        <StaffToolsPanel
          rooms={rooms}
          activeRoomId={activeRoomId || null}
          onClose={() => setShowStaffTools(false)}
        />
      )}
    </div>
  );
}
