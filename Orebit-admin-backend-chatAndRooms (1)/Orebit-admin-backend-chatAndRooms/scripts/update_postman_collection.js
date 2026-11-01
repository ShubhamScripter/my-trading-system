const fs = require('fs');
const path = require('path');

// Read Chat & Moderation Postman items from generate_chat_docs_and_postman.js
const genScriptPath = path.resolve(__dirname, '../../Chat-admin/scripts/generate_chat_docs_and_postman.js');
let chatItems = [];
let chatVariables = [];

if (fs.existsSync(genScriptPath)) {
  const content = fs.readFileSync(genScriptPath, 'utf8');
  const postmanMatch = content.match(/const postmanCollection = (\{[\s\S]*?\});\s*fs\.writeFileSync/);
  if (postmanMatch) {
    try {
      const parsed = eval('(' + postmanMatch[1] + ')');
      chatItems = parsed.item || [];
      chatVariables = parsed.variable || [];
    } catch (e) {
      console.error('Error evaluating postmanCollection from generator:', e.message);
    }
  }
}

// Target collection file
const targetCollectionPath = 'E:/Orebit-modules/docs/Orebit-api\'s.postman_collection.json';
const adminCollectionBackup = path.resolve(__dirname, '../docs/Orebit_Admin.postman_collection.json');

// Full Admin Chat & Moderation item structure if fallback needed
if (!chatItems || chatItems.length === 0) {
  chatItems = [
    {
      name: "01. Stats & Overview",
      item: [
        {
          name: "Get Chat Platform Stats",
          request: {
            method: "GET",
            header: [{ key: "Accept", value: "application/json" }],
            url: {
              raw: "{{adminBaseUrl}}/social/chat/stats",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "stats"]
            },
            description: "Returns platform aggregate metrics: active rooms, live chatters, total messages sent, pending reports, active bans, and rainpool volume."
          }
        }
      ]
    },
    {
      name: "02. Room Management",
      item: [
        {
          name: "List All Rooms",
          request: {
            method: "GET",
            header: [{ key: "Accept", value: "application/json" }],
            url: {
              raw: "{{adminBaseUrl}}/social/chat/rooms",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "rooms"]
            },
            description: "Retrieves all chat rooms with active participant count, message metrics, content controls, and settings."
          }
        },
        {
          name: "Create Room",
          request: {
            method: "POST",
            header: [
              { key: "Content-Type", value: "application/json" },
              { key: "Accept", value: "application/json" }
            ],
            body: {
              mode: "raw",
              raw: JSON.stringify({
                name: "High Rollers VIP",
                slug: "high-rollers-vip",
                type: "PREMIUM",
                description: "High stakes lounge for VIP tier 1+ users",
                language: "English",
                continent: "Global",
                linksPolicy: "ALL_LINKS",
                rules: [
                  "Be respectful to all players",
                  "No spamming rain requests"
                ],
                contentControls: {
                  allowText: true,
                  allowGif: true,
                  allowImage: true,
                  allowVideo: false,
                  allowEmoji: true,
                  autoModeration: true,
                  allowCommands: true,
                  allowAds: true
                },
                accessSettings: {
                  requirePremium: true,
                  requireVip: false,
                  requireKyc: false,
                  requireMerchant: false,
                  isViewOnlyForOthers: true
                }
              }, null, 2)
            },
            url: {
              raw: "{{adminBaseUrl}}/social/chat/rooms",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "rooms"]
            }
          }
        },
        {
          name: "Update Room",
          request: {
            method: "POST",
            header: [
              { key: "Content-Type", value: "application/json" },
              { key: "Accept", value: "application/json" }
            ],
            body: {
              mode: "raw",
              raw: JSON.stringify({
                roomId: "{{roomId}}",
                name: "High Rollers VIP (Updated)",
                status: "ACTIVE",
                linksPolicy: "ALL_LINKS"
              }, null, 2)
            },
            url: {
              raw: "{{adminBaseUrl}}/social/chat/rooms/update",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "rooms", "update"]
            }
          }
        },
        {
          name: "Update Room Controls",
          request: {
            method: "POST",
            header: [
              { key: "Content-Type", value: "application/json" },
              { key: "Accept", value: "application/json" }
            ],
            body: {
              mode: "raw",
              raw: JSON.stringify({
                roomId: "{{roomId}}",
                controls: {
                  allowGif: false,
                  allowVideo: false,
                  autoModeration: true
                }
              }, null, 2)
            },
            url: {
              raw: "{{adminBaseUrl}}/social/chat/rooms/controls",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "rooms", "controls"]
            }
          }
        },
        {
          name: "Delete (Soft-Delete) Room",
          request: {
            method: "POST",
            header: [
              { key: "Content-Type", value: "application/json" },
              { key: "Accept", value: "application/json" }
            ],
            body: {
              mode: "raw",
              raw: JSON.stringify({
                roomId: "{{roomId}}"
              }, null, 2)
            },
            url: {
              raw: "{{adminBaseUrl}}/social/chat/rooms/delete",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "rooms", "delete"]
            }
          }
        }
      ]
    },
    {
      name: "03. Room Rules",
      item: [
        {
          name: "Get Room Rules",
          request: {
            method: "GET",
            header: [{ key: "Accept", value: "application/json" }],
            url: {
              raw: "{{adminBaseUrl}}/social/chat/rules?roomId={{roomId}}",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "rules"],
              query: [{ key: "roomId", value: "{{roomId}}" }]
            }
          }
        },
        {
          name: "Update Room Rules",
          request: {
            method: "POST",
            header: [
              { key: "Content-Type", value: "application/json" },
              { key: "Accept", value: "application/json" }
            ],
            body: {
              mode: "raw",
              raw: JSON.stringify({
                roomId: "{{roomId}}",
                rules: [
                  "1. Respect community members and moderators.",
                  "2. No phishing, scam links, or malicious software.",
                  "3. Rain and tip begging is strictly disallowed."
                ]
              }, null, 2)
            },
            url: {
              raw: "{{adminBaseUrl}}/social/chat/rules",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "rules"]
            }
          }
        }
      ]
    },
    {
      name: "04. Moderation Reports",
      item: [
        {
          name: "Get Moderation Reports",
          request: {
            method: "GET",
            header: [{ key: "Accept", value: "application/json" }],
            url: {
              raw: "{{adminBaseUrl}}/social/chat/reports?status=ALL",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "reports"],
              query: [{ key: "status", value: "ALL" }]
            }
          }
        },
        {
          name: "Action Report (BAN / DELETE_MESSAGE / WARN / DISMISS)",
          request: {
            method: "POST",
            header: [
              { key: "Content-Type", value: "application/json" },
              { key: "Accept", value: "application/json" }
            ],
            body: {
              mode: "raw",
              raw: JSON.stringify({
                reportId: "{{reportId}}",
                action: "BAN",
                reason: "Severe hate speech and spamming"
              }, null, 2)
            },
            url: {
              raw: "{{adminBaseUrl}}/social/chat/reports/action",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "reports", "action"]
            }
          }
        }
      ]
    },
    {
      name: "05. Sanctions & Bans",
      item: [
        {
          name: "List Active Bans",
          request: {
            method: "GET",
            header: [{ key: "Accept", value: "application/json" }],
            url: {
              raw: "{{adminBaseUrl}}/social/chat/bans",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "bans"]
            }
          }
        },
        {
          name: "Create User Ban",
          request: {
            method: "POST",
            header: [
              { key: "Content-Type", value: "application/json" },
              { key: "Accept", value: "application/json" }
            ],
            body: {
              mode: "raw",
              raw: JSON.stringify({
                userId: "00000000-0000-0000-0000-000000000002",
                roomId: "{{roomId}}",
                reason: "Violation of chat code of conduct",
                durationHours: 24
              }, null, 2)
            },
            url: {
              raw: "{{adminBaseUrl}}/social/chat/bans",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "bans"]
            }
          }
        },
        {
          name: "Unban User",
          request: {
            method: "POST",
            header: [
              { key: "Content-Type", value: "application/json" },
              { key: "Accept", value: "application/json" }
            ],
            body: {
              mode: "raw",
              raw: JSON.stringify({
                banId: "{{banId}}"
              }, null, 2)
            },
            url: {
              raw: "{{adminBaseUrl}}/social/chat/bans/unban",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "bans", "unban"]
            }
          }
        },
        {
          name: "Assign User Staff Role",
          request: {
            method: "POST",
            header: [
              { key: "Content-Type", value: "application/json" },
              { key: "Accept", value: "application/json" }
            ],
            body: {
              mode: "raw",
              raw: JSON.stringify({
                userId: "00000000-0000-0000-0000-000000000002",
                role: "MODERATOR"
              }, null, 2)
            },
            url: {
              raw: "{{adminBaseUrl}}/social/chat/staff/assign-role",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "staff", "assign-role"]
            }
          }
        }
      ]
    },
    {
      name: "06. Cosmetics Management",
      item: [
        {
          name: "List Cosmetics",
          request: {
            method: "GET",
            header: [{ key: "Accept", value: "application/json" }],
            url: {
              raw: "{{adminBaseUrl}}/social/chat/cosmetics",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "cosmetics"]
            }
          }
        },
        {
          name: "Create Cosmetic",
          request: {
            method: "POST",
            header: [
              { key: "Content-Type", value: "application/json" },
              { key: "Accept", value: "application/json" }
            ],
            body: {
              mode: "raw",
              raw: JSON.stringify({
                name: "Gold VIP Aura",
                description: "Golden radiant message border for high rollers",
                gradient: "linear-gradient(135deg, #ffd700, #ffaa00)",
                borderColor: "#ffd700",
                badgeIcon: "👑",
                cost: 250,
                isPremium: true,
                isActive: true
              }, null, 2)
            },
            url: {
              raw: "{{adminBaseUrl}}/social/chat/cosmetics",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "cosmetics"]
            }
          }
        },
        {
          name: "Delete Cosmetic",
          request: {
            method: "POST",
            header: [
              { key: "Content-Type", value: "application/json" },
              { key: "Accept", value: "application/json" }
            ],
            body: {
              mode: "raw",
              raw: JSON.stringify({
                id: "{{cosmeticId}}"
              }, null, 2)
            },
            url: {
              raw: "{{adminBaseUrl}}/social/chat/cosmetics/delete",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "cosmetics", "delete"]
            }
          }
        }
      ]
    },
    {
      name: "07. Broadcast & Retraction",
      item: [
        {
          name: "Send Broadcast Announcement",
          request: {
            method: "POST",
            header: [
              { key: "Content-Type", value: "application/json" },
              { key: "Accept", value: "application/json" }
            ],
            body: {
              mode: "raw",
              raw: JSON.stringify({
                roomId: null,
                title: "Maintenance Notice",
                content: "Scheduled system upgrade in 15 minutes. Chat will remain operational.",
                type: "MAINTENANCE",
                priority: "HIGH"
              }, null, 2)
            },
            url: {
              raw: "{{adminBaseUrl}}/social/chat/broadcast",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "broadcast"]
            }
          }
        },
        {
          name: "Retract Message",
          request: {
            method: "POST",
            header: [
              { key: "Content-Type", value: "application/json" },
              { key: "Accept", value: "application/json" }
            ],
            body: {
              mode: "raw",
              raw: JSON.stringify({
                messageId: "{{messageId}}"
              }, null, 2)
            },
            url: {
              raw: "{{adminBaseUrl}}/social/chat/retract",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "retract"]
            }
          }
        },
        {
          name: "Get Room Message History",
          request: {
            method: "GET",
            header: [{ key: "Accept", value: "application/json" }],
            url: {
              raw: "{{adminBaseUrl}}/social/chat/history?roomId={{roomId}}&limit=50&offset=0",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "history"],
              query: [
                { key: "roomId", value: "{{roomId}}" },
                { key: "limit", value: "50" },
                { key: "offset", value: "0" }
              ]
            }
          }
        }
      ]
    },
    {
      name: "08. Advanced Moderation & Automation Settings",
      item: [
        {
          name: "Get Room Moderation Settings",
          request: {
            method: "GET",
            header: [{ key: "Accept", value: "application/json" }],
            url: {
              raw: "{{adminBaseUrl}}/social/chat/moderation-settings?roomId={{roomId}}",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "moderation-settings"],
              query: [{ key: "roomId", value: "{{roomId}}" }]
            }
          }
        },
        {
          name: "Save Room Moderation Settings",
          request: {
            method: "POST",
            header: [
              { key: "Content-Type", value: "application/json" },
              { key: "Accept", value: "application/json" }
            ],
            body: {
              mode: "raw",
              raw: JSON.stringify({
                roomId: "{{roomId}}",
                spamProtection: {
                  enabled: true,
                  repeatCount: 3,
                  windowSeconds: 10
                },
                autoBanSequence: [
                  { tier: 1, action: "WARNING", resetWindowHours: 24 },
                  { tier: 2, action: "BAN", durationSeconds: 3600, resetWindowHours: 48 },
                  { tier: 3, action: "BAN", durationSeconds: 86400, resetWindowHours: 168 }
                ],
                linkPolicy: "OREBIT_ONLY",
                bannedWords: ["scam", "free money", "t.me/"],
                globalDisabledCommands: ["/ad"],
                allCommandsDisabled: false
              }, null, 2)
            },
            url: {
              raw: "{{adminBaseUrl}}/social/chat/moderation-settings",
              host: ["{{adminBaseUrl}}"],
              path: ["social", "chat", "moderation-settings"]
            }
          }
        }
      ]
    }
  ];
}

// Ensure Admin Auth is also present and complete
const adminAuthItem = {
  name: "00. Admin Authentication",
  item: [
    {
      name: "Admin Login (Start Step)",
      request: {
        method: "POST",
        header: [
          { key: "Content-Type", value: "application/json" },
          { key: "Accept", value: "application/json" }
        ],
        body: {
          mode: "raw",
          raw: JSON.stringify({
            step: "start",
            identifier: "admin@orebit.com"
          }, null, 2)
        },
        url: {
          raw: "{{adminBaseUrl}}/auth/login",
          host: ["{{adminBaseUrl}}"],
          path: ["auth", "login"]
        }
      }
    },
    {
      name: "Get Current Admin Profile (/auth/me)",
      request: {
        method: "GET",
        header: [
          { key: "Accept", value: "application/json" }
        ],
        url: {
          raw: "{{adminBaseUrl}}/auth/me",
          host: ["{{adminBaseUrl}}"],
          path: ["auth", "me"]
        }
      }
    },
    {
      name: "Get Admin Session Status (/auth/session)",
      request: {
        method: "GET",
        header: [
          { key: "Accept", value: "application/json" }
        ],
        url: {
          raw: "{{adminBaseUrl}}/auth/session",
          host: ["{{adminBaseUrl}}"],
          path: ["auth", "session"]
        }
      }
    }
  ]
};

// Also add Admin Operations (Admins, 2FA, Security Policies, Captcha, Countries)
const adminOpsItem = {
  name: "09. Platform Administration",
  item: [
    {
      name: "Get Admin Login Reviews",
      request: {
        method: "GET",
        header: [{ key: "Accept", value: "application/json" }],
        url: {
          raw: "{{adminBaseUrl}}/admins/login-reviews",
          host: ["{{adminBaseUrl}}"],
          path: ["admins", "login-reviews"]
        }
      }
    },
    {
      name: "Get 2FA Status",
      request: {
        method: "GET",
        header: [{ key: "Accept", value: "application/json" }],
        url: {
          raw: "{{adminBaseUrl}}/2fa",
          host: ["{{adminBaseUrl}}"],
          path: ["2fa"]
        }
      }
    },
    {
      name: "Get Security Policies",
      request: {
        method: "GET",
        header: [{ key: "Accept", value: "application/json" }],
        url: {
          raw: "{{adminBaseUrl}}/security-policies",
          host: ["{{adminBaseUrl}}"],
          path: ["security-policies"]
        }
      }
    },
    {
      name: "Get Captcha Config",
      request: {
        method: "GET",
        header: [{ key: "Accept", value: "application/json" }],
        url: {
          raw: "{{adminBaseUrl}}/captcha",
          host: ["{{adminBaseUrl}}"],
          path: ["captcha"]
        }
      }
    },
    {
      name: "Get Countries List",
      request: {
        method: "GET",
        header: [{ key: "Accept", value: "application/json" }],
        url: {
          raw: "{{adminBaseUrl}}/countries",
          host: ["{{adminBaseUrl}}"],
          path: ["countries"]
        }
      }
    }
  ]
};

// Build the updated Admin folder
const adminFolder = {
  name: "Admin",
  description: "Orebit Administrator Control Panel APIs (Authentication, Social Chat & Moderation, Platform Security, Countries, Policies).",
  item: [
    adminAuthItem,
    ...chatItems.map(folder => {
      // Normalize baseUrl to adminBaseUrl if needed
      const serialized = JSON.stringify(folder);
      const replaced = serialized.replace(/\{\{baseUrl\}\}/g, '{{adminBaseUrl}}');
      return JSON.parse(replaced);
    }),
    adminOpsItem
  ]
};

// 1. Update E:/Orebit-modules/docs/Orebit-api's.postman_collection.json if exists
if (fs.existsSync(targetCollectionPath)) {
  try {
    const raw = fs.readFileSync(targetCollectionPath, 'utf8');
    const col = JSON.parse(raw);
    
    // Ensure adminBaseUrl variable exists
    col.variable = col.variable || [];
    const varKeys = new Set(col.variable.map(v => v.key));
    if (!varKeys.has('adminBaseUrl')) {
      col.variable.push({
        key: "adminBaseUrl",
        value: "http://localhost:3002",
        type: "string"
      });
    }
    if (!varKeys.has('roomId')) {
      col.variable.push({ key: "roomId", value: "00000000-0000-0000-0000-000000000001", type: "string" });
    }
    if (!varKeys.has('reportId')) {
      col.variable.push({ key: "reportId", value: "00000000-0000-0000-0000-000000000001", type: "string" });
    }
    if (!varKeys.has('banId')) {
      col.variable.push({ key: "banId", value: "00000000-0000-0000-0000-000000000001", type: "string" });
    }
    if (!varKeys.has('cosmeticId')) {
      col.variable.push({ key: "cosmeticId", value: "00000000-0000-0000-0000-000000000001", type: "string" });
    }
    if (!varKeys.has('messageId')) {
      col.variable.push({ key: "messageId", value: "00000000-0000-0000-0000-000000000001", type: "string" });
    }

    // Replace or add the Admin folder
    const existingIndex = col.item.findIndex(i => i.name === 'Admin');
    if (existingIndex !== -1) {
      col.item[existingIndex] = adminFolder;
    } else {
      col.item.push(adminFolder);
    }

    fs.writeFileSync(targetCollectionPath, JSON.stringify(col, null, 2), 'utf8');
    console.log('Successfully updated Postman collection at:', targetCollectionPath);
  } catch (err) {
    console.error('Failed to update target collection:', err.message);
  }
}

// 2. Also save a standalone admin collection in Orebit-admin-backend/docs/
const standaloneCollection = {
  info: {
    _postman_id: "orebit-admin-control-panel-api",
    name: "Orebit Admin Control Panel API",
    description: "Complete Postman collection for Orebit Admin Backend (Auth, Chat & Moderation, Admins, 2FA, Captcha, Policies, Countries).",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  variable: [
    { key: "adminBaseUrl", value: "http://localhost:3002", type: "string" },
    { key: "roomId", value: "00000000-0000-0000-0000-000000000001", type: "string" },
    { key: "reportId", value: "00000000-0000-0000-0000-000000000001", type: "string" },
    { key: "banId", value: "00000000-0000-0000-0000-000000000001", type: "string" },
    { key: "cosmeticId", value: "00000000-0000-0000-0000-000000000001", type: "string" },
    { key: "messageId", value: "00000000-0000-0000-0000-000000000001", type: "string" }
  ],
  item: adminFolder.item
};

fs.mkdirSync(path.dirname(adminCollectionBackup), { recursive: true });
fs.writeFileSync(adminCollectionBackup, JSON.stringify(standaloneCollection, null, 2), 'utf8');
console.log('Successfully created standalone Admin Postman Collection at:', adminCollectionBackup);
