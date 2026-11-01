import React, { useState, useEffect } from 'react';
import { AdminRoom, RoomType, PremiumTier } from '../../types';
import { CountryMultiSelect } from '../common/CountryMultiSelect';

interface EditRoomModalProps {
  isOpen: boolean;
  room: AdminRoom | null;
  onClose: () => void;
  onSave: (data: any) => void;
}

const CATEGORIES: Array<{ type: RoomType; label: string }> = [
  { type: 'GLOBAL', label: 'Global Public' },
  { type: 'PREMIUM', label: 'Premium Plan' },
  { type: 'CASINO', label: 'Casino Floor' },
  { type: 'COUNTRY', label: 'Country' },
  { type: 'REGION', label: 'Region' },
  { type: 'LANGUAGE', label: 'Language Room' },
  { type: 'KYC', label: 'KYC Only' },
  { type: 'SO', label: 'Merchant' },
  { type: 'STAFF', label: 'Staff' },
];

const PRESET_RULES: Record<RoomType, string[]> = {
  GLOBAL: ['Be respectful to members', 'No spam or promo links'],
  PREMIUM: ['Premium members only', 'No unsolicited DMs or promotion'],
  VIP: ['VIP high rollers lounge', 'Strict confidentiality, no harassment'],
  CASINO: ['Casino discussion only', 'No begging for tips or rain'],
  COUNTRY: ['Local community discussion only', 'No harassment'],
  REGION: ['Regional community discussion', 'Respect all languages'],
  LANGUAGE: ['Discussion in the room language only', 'No spam or promo links'],
  CONTINENT: ['Continental community discussion only'],
  KYC: ['KYC-verified members only'],
  SO: ['Merchant coordination only'],
  STAFF: ['Staff coordination only'],
};

const POPULAR_COUNTRIES = [
  { code: 'US', name: 'USA', lang: 'EN' },
  { code: 'IN', name: 'India', lang: 'HI' },
  { code: 'BR', name: 'Brazil', lang: 'PT' },
  { code: 'GB', name: 'UK', lang: 'EN' },
  { code: 'DE', name: 'Germany', lang: 'DE' },
  { code: 'CA', name: 'Canada', lang: 'EN' },
  { code: 'ES', name: 'Spain', lang: 'ES' },
  { code: 'JP', name: 'Japan', lang: 'JA' },
];

// Full ISO 3166-1 alpha-2 list. `evaluateRoomAccess` (chat.utility.ts) matches
// `user.country` against this code, exact and case-insensitive, for ANY room
// type that sets `allowedCountries` — the restriction was never actually tied
// to the COUNTRY/REGION room types, only the form's UI was.
const COUNTRIES = [
  { code: 'AF', name: 'Afghanistan' }, { code: 'AL', name: 'Albania' }, { code: 'DZ', name: 'Algeria' },
  { code: 'AR', name: 'Argentina' }, { code: 'AM', name: 'Armenia' }, { code: 'AU', name: 'Australia' },
  { code: 'AT', name: 'Austria' }, { code: 'AZ', name: 'Azerbaijan' }, { code: 'BH', name: 'Bahrain' },
  { code: 'BD', name: 'Bangladesh' }, { code: 'BY', name: 'Belarus' }, { code: 'BE', name: 'Belgium' },
  { code: 'BZ', name: 'Belize' }, { code: 'BO', name: 'Bolivia' }, { code: 'BA', name: 'Bosnia and Herzegovina' },
  { code: 'BW', name: 'Botswana' }, { code: 'BR', name: 'Brazil' }, { code: 'BN', name: 'Brunei' },
  { code: 'BG', name: 'Bulgaria' }, { code: 'KH', name: 'Cambodia' }, { code: 'CM', name: 'Cameroon' },
  { code: 'CA', name: 'Canada' }, { code: 'CL', name: 'Chile' }, { code: 'CN', name: 'China' },
  { code: 'CO', name: 'Colombia' }, { code: 'CR', name: 'Costa Rica' }, { code: 'HR', name: 'Croatia' },
  { code: 'CU', name: 'Cuba' }, { code: 'CY', name: 'Cyprus' }, { code: 'CZ', name: 'Czech Republic' },
  { code: 'DK', name: 'Denmark' }, { code: 'DO', name: 'Dominican Republic' }, { code: 'EC', name: 'Ecuador' },
  { code: 'EG', name: 'Egypt' }, { code: 'SV', name: 'El Salvador' }, { code: 'EE', name: 'Estonia' },
  { code: 'ET', name: 'Ethiopia' }, { code: 'FI', name: 'Finland' }, { code: 'FR', name: 'France' },
  { code: 'GE', name: 'Georgia' }, { code: 'DE', name: 'Germany' }, { code: 'GH', name: 'Ghana' },
  { code: 'GR', name: 'Greece' }, { code: 'GT', name: 'Guatemala' }, { code: 'HN', name: 'Honduras' },
  { code: 'HK', name: 'Hong Kong' }, { code: 'HU', name: 'Hungary' }, { code: 'IS', name: 'Iceland' },
  { code: 'IN', name: 'India' }, { code: 'ID', name: 'Indonesia' }, { code: 'IR', name: 'Iran' },
  { code: 'IQ', name: 'Iraq' }, { code: 'IE', name: 'Ireland' }, { code: 'IL', name: 'Israel' },
  { code: 'IT', name: 'Italy' }, { code: 'JM', name: 'Jamaica' }, { code: 'JP', name: 'Japan' },
  { code: 'JO', name: 'Jordan' }, { code: 'KZ', name: 'Kazakhstan' }, { code: 'KE', name: 'Kenya' },
  { code: 'KW', name: 'Kuwait' }, { code: 'KG', name: 'Kyrgyzstan' }, { code: 'LA', name: 'Laos' },
  { code: 'LV', name: 'Latvia' }, { code: 'LB', name: 'Lebanon' }, { code: 'LY', name: 'Libya' },
  { code: 'LT', name: 'Lithuania' }, { code: 'LU', name: 'Luxembourg' }, { code: 'MY', name: 'Malaysia' },
  { code: 'MV', name: 'Maldives' }, { code: 'MT', name: 'Malta' }, { code: 'MX', name: 'Mexico' },
  { code: 'MD', name: 'Moldova' }, { code: 'MC', name: 'Monaco' }, { code: 'MN', name: 'Mongolia' },
  { code: 'ME', name: 'Montenegro' }, { code: 'MA', name: 'Morocco' }, { code: 'MM', name: 'Myanmar' },
  { code: 'NP', name: 'Nepal' }, { code: 'NL', name: 'Netherlands' }, { code: 'NZ', name: 'New Zealand' },
  { code: 'NI', name: 'Nicaragua' }, { code: 'NG', name: 'Nigeria' }, { code: 'NO', name: 'Norway' },
  { code: 'OM', name: 'Oman' }, { code: 'PK', name: 'Pakistan' }, { code: 'PA', name: 'Panama' },
  { code: 'PY', name: 'Paraguay' }, { code: 'PE', name: 'Peru' }, { code: 'PH', name: 'Philippines' },
  { code: 'PL', name: 'Poland' }, { code: 'PT', name: 'Portugal' }, { code: 'QA', name: 'Qatar' },
  { code: 'RO', name: 'Romania' }, { code: 'RU', name: 'Russia' }, { code: 'SA', name: 'Saudi Arabia' },
  { code: 'RS', name: 'Serbia' }, { code: 'SG', name: 'Singapore' }, { code: 'SK', name: 'Slovakia' },
  { code: 'SI', name: 'Slovenia' }, { code: 'ZA', name: 'South Africa' }, { code: 'KR', name: 'South Korea' },
  { code: 'ES', name: 'Spain' }, { code: 'LK', name: 'Sri Lanka' }, { code: 'SE', name: 'Sweden' },
  { code: 'CH', name: 'Switzerland' }, { code: 'TW', name: 'Taiwan' }, { code: 'TJ', name: 'Tajikistan' },
  { code: 'TZ', name: 'Tanzania' }, { code: 'TH', name: 'Thailand' }, { code: 'TN', name: 'Tunisia' },
  { code: 'TR', name: 'Turkey' }, { code: 'TM', name: 'Turkmenistan' }, { code: 'UG', name: 'Uganda' },
  { code: 'UA', name: 'Ukraine' }, { code: 'AE', name: 'United Arab Emirates' }, { code: 'GB', name: 'United Kingdom' },
  { code: 'US', name: 'United States' }, { code: 'UY', name: 'Uruguay' }, { code: 'UZ', name: 'Uzbekistan' },
  { code: 'VE', name: 'Venezuela' }, { code: 'VN', name: 'Vietnam' }, { code: 'YE', name: 'Yemen' },
  { code: 'ZM', name: 'Zambia' }, { code: 'ZW', name: 'Zimbabwe' },
].sort((a, b) => a.name.localeCompare(b.name));

const LANGUAGES = [
  { code: 'EN', name: 'English' }, { code: 'HI', name: 'Hindi' }, { code: 'ES', name: 'Spanish' },
  { code: 'PT', name: 'Portuguese' }, { code: 'DE', name: 'German' }, { code: 'FR', name: 'French' },
  { code: 'JA', name: 'Japanese' }, { code: 'ZH', name: 'Chinese' }, { code: 'AR', name: 'Arabic' },
  { code: 'RU', name: 'Russian' }, { code: 'IT', name: 'Italian' }, { code: 'KO', name: 'Korean' },
  { code: 'TR', name: 'Turkish' }, { code: 'VI', name: 'Vietnamese' }, { code: 'TH', name: 'Thai' },
  { code: 'ID', name: 'Indonesian' }, { code: 'MS', name: 'Malay' }, { code: 'BN', name: 'Bengali' },
  { code: 'UR', name: 'Urdu' }, { code: 'TA', name: 'Tamil' }, { code: 'TE', name: 'Telugu' },
  { code: 'MR', name: 'Marathi' }, { code: 'GU', name: 'Gujarati' }, { code: 'PA', name: 'Punjabi' },
  { code: 'NL', name: 'Dutch' }, { code: 'PL', name: 'Polish' }, { code: 'MULTI', name: 'Multi-Language' },
];

const CONTINENTS = ['GLOBAL', 'ASIA', 'EUROPE', 'AMERICAS', 'LATAM', 'MIDDLE_EAST', 'AFRICA'];

export const EditRoomModal: React.FC<EditRoomModalProps> = ({
  isOpen,
  room,
  onClose,
  onSave,
}) => {
  const [type, setType] = useState<RoomType>('GLOBAL');

  // Core Fields
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [isSlugLocked, setIsSlugLocked] = useState(true);
  const [status, setStatus] = useState<'ACTIVE' | 'MAINTENANCE' | 'DISABLED'>('ACTIVE');
  const [language, setLanguage] = useState('EN');
  const [continent, setContinent] = useState('GLOBAL');
  const [description, setDescription] = useState('');

  // Access & Ineligibility
  const [ineligibleBehavior, setIneligibleBehavior] = useState<'VIEW_ONLY' | 'HIDE' | 'PROMO_ONLY'>('VIEW_ONLY');
  const [minLevel, setMinLevel] = useState(0);
  const [minWagerUsd, setMinWagerUsd] = useState(0);
  const [requireKyc, setRequireKyc] = useState(false);
  const [requireVip, setRequireVip] = useState(false);
  const [requireMerchant, setRequireMerchant] = useState(false);
  const [premiumTier, setPremiumTier] = useState<PremiumTier>('ALL');
  const [countryCode, setCountryCode] = useState('');
  const [allowedCountriesList, setAllowedCountriesList] = useState<string[]>([]);
  const [viewOnlyCountriesInput, setViewOnlyCountriesInput] = useState('');
  const [separateRegionVip, setSeparateRegionVip] = useState(false);

  // Casino
  const [casinoAutoSwitch, setCasinoAutoSwitch] = useState(false);
  const [casinoSwitchIfDmOpen, setCasinoSwitchIfDmOpen] = useState(false);
  const [casinoRequireOpen, setCasinoRequireOpen] = useState(false);
  const [casinoMinWagerUsd, setCasinoMinWagerUsd] = useState(0);
  const [statusNote, setStatusNote] = useState('');
  const [savedAccess, setSavedAccess] = useState<any>({});
  const [casinoSeparateVip, setCasinoSeparateVip] = useState(false);

  // SO
  const [soIsMerchantRoom, setSoIsMerchantRoom] = useState(false);
  const [soSeparateVip, setSoSeparateVip] = useState(false);

  // Media & Moderation
  const [allowText, setAllowText] = useState(true);
  const [allowGif, setAllowGif] = useState(true);
  const [allowImage, setAllowImage] = useState(true);
  const [allowVideo, setAllowVideo] = useState(false);
  const [allowEmoji, setAllowEmoji] = useState(true);
  const [autoModeration, setAutoModeration] = useState(true);
  const [linksPolicy, setLinksPolicy] = useState<'OREBIT_ONLY' | 'NO_LINKS' | 'ALL_LINKS'>('ALL_LINKS');
  const [allowedCommands, setAllowedCommands] = useState<string[]>(['/rain', '/gift', '/pm', '/ad', '/mute']);
  const [adsAllowed, setAdsAllowed] = useState(false);
  const [allowCommands, setAllowCommands] = useState(false);
  const [pinnedAdsAllowed, setPinnedAdsAllowed] = useState(true);
  const [visibility, setVisibility] = useState<'ALL' | 'PREMIUM' | 'VIP' | 'STAFF' | 'KYC'>('ALL');
  const [bannedWordsInput, setBannedWordsInput] = useState('');
  // "Room Controls ... ON / OFF / MAINTENANCE": the controls put under maintenance in this room.
  const [controlsMaintenance, setControlsMaintenance] = useState<string[]>([]);
  // "(Can be scheduled)": empty = apply now.
  const [effectiveAt, setEffectiveAt] = useState('');

  // Rules
  const [rules, setRules] = useState<string[]>([]);

  const cleanSlug = (input: string) =>
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');

  useEffect(() => {
    if (room) {
      setType(room.type || 'GLOBAL');
      setName(room.name || '');
      setSlug(room.slug || '');
      setIsSlugLocked(true);
      setStatus(room.status || 'ACTIVE');
      setStatusNote(room.statusNote || '');
      setLanguage(room.language || 'EN');
      setContinent((room as any).continent || 'GLOBAL');
      setDescription(room.description || '');

      // The room's access rule exactly as stored (CH-012): nothing is guessed from the room type.
      const acc = (room.access || {}) as any;
      setSavedAccess(acc);
      setIneligibleBehavior(acc.ineligibleMode || 'VIEW_ONLY');
      setMinLevel(acc.minLevel ?? 0);
      setRequireKyc((acc.minKycLevel ?? 0) > 0);
      setRequireVip(false);
      setRequireMerchant(room.type === 'SO');
      setPremiumTier('ALL');

      const countries: string[] = acc.allowedCountries || [];
      setAllowedCountriesList(countries);
      setCountryCode(countries.length === 1 ? countries[0]! : '');
      setViewOnlyCountriesInput('');

      // Casino: the saved minimum wager (decimal string) and whether it applies (D-10).
      const wager = acc.minWagerUsd != null ? Number(acc.minWagerUsd) : 0;
      setCasinoMinWagerUsd(wager);
      setMinWagerUsd(wager);
      setCasinoRequireOpen(true);
      setCasinoAutoSwitch(false);
      setCasinoSwitchIfDmOpen(false);
      setCasinoSeparateVip(false);
      setSoIsMerchantRoom(room.type === 'SO');
      setSoSeparateVip(false);
      setSeparateRegionVip(false);

      const cc = (room.contentControls || {}) as any;
      setAllowText(cc.allowText !== false);
      setAllowGif(cc.allowGif !== false);
      setAllowImage(cc.allowImage === true);
      setAllowVideo(cc.allowVideo === true);
      setAllowEmoji(cc.allowEmoji !== false);
      setAutoModeration(cc.autoModeration !== false);

      // No stored policy means links are off (D-15) — never default to "allow all".
      setLinksPolicy((room.linksPolicy as any) || 'NO_LINKS');
      // The stored command names back as the modal's chips ("send" is shown as /gift, "dm" as /pm).
      const chip: Record<string, string> = { send: '/gift', dm: '/pm' };
      // No stored list means every command is allowed, so every chip starts on.
      setAllowedCommands(
        Array.isArray((cc as any).commands)
          ? (cc as any).commands.map((c: string) => chip[c] ?? `/${c}`)
          : ['/rain', '/gift', '/pm', '/ad', '/mute'],
      );
      setAdsAllowed(cc.allowAds === true);
      setAllowCommands(cc.allowCommands === true);
      setPinnedAdsAllowed(false);
      setVisibility('ALL');
      setBannedWordsInput((room.bannedWords || []).join(', '));
      setControlsMaintenance(room.controlsMaintenance ?? []);
      setEffectiveAt('');

      setRules(room.rules && room.rules.length > 0 ? room.rules : []);
    }
  }, [room]);

  const handleCountrySelect = (c: { code: string; name: string; lang: string }) => {
    setCountryCode(c.code);
    setAllowedCountriesList([c.code]);
    setLanguage(c.lang);
  };

  const handleRuleChange = (index: number, val: string) => {
    const updated = [...rules];
    updated[index] = val;
    setRules(updated);
  };

  const handleAddRule = () => {
    setRules([...rules, '']);
  };

  const handleRemoveRule = (index: number) => {
    setRules(rules.filter((_, i) => i !== index));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!room || !name.trim()) return;

    const finalSlug = cleanSlug(slug || name);

    const allowedCountries: string[] =
      type === 'COUNTRY' && countryCode
        ? [countryCode.toUpperCase()]
        : allowedCountriesList.map((c) => c.toUpperCase());

    const viewOnlyCountries = viewOnlyCountriesInput
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter((c) => c.length === 2);

    const bannedWords = bannedWordsInput
      .split(',')
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);

    onSave({
      roomId: room.id,
      name: name.trim(),
      slug: finalSlug,
      type,
      status,
      statusNote: status === 'MAINTENANCE' && statusNote.trim() ? statusNote.trim() : null,
      language: language.trim().toUpperCase() || 'EN',
      continent: continent.trim().toUpperCase() || 'GLOBAL',
      description: description.trim(),
      linksPolicy: linksPolicy === 'NO_LINKS' ? null : linksPolicy,
      bannedWords,
      allowedCommands,
      adsAllowed,
      pinnedAdsAllowed,
      casinoSettings: {
        autoSwitch: type === 'CASINO' ? casinoAutoSwitch : false,
        switchIfDmOpen: type === 'CASINO' ? casinoSwitchIfDmOpen : false,
        requireCasinoOpen: type === 'CASINO' ? casinoRequireOpen : false,
        minWagerUsd: type === 'CASINO' ? Number(casinoMinWagerUsd) || 0 : 0,
        separatePremiumCasino: type === 'CASINO' ? casinoSeparateVip : false,
      },
      soSettings: {
        isSoRoom: type === 'SO' ? true : soIsMerchantRoom,
        separateSoPremium: type === 'SO' ? soSeparateVip : false,
      },
      regionSettings: {
        separateVipRoom: type === 'REGION' || type === 'COUNTRY' ? separateRegionVip : false,
      },
      rules: rules.map((r) => r.trim()).filter(Boolean),
      contentControls: {
        allowText,
        allowGif,
        allowImage,
        allowVideo,
        allowEmoji,
        autoModeration,
        allowCommands,
        allowAds: adsAllowed,
      },
      controlsMaintenance,
      effectiveAt: effectiveAt || undefined,
      // Casino: "on the casino" is always required; the minimum wager applies when it is above 0 (D-10).
      ...(type === 'CASINO' ? { casino: { onlyUsersOnCasino: (Number(casinoMinWagerUsd) || 0) > 0 } } : {}),
      access: {
        allowedCountries,
        regionId: null,
        requirePremium: type === 'PREMIUM' || premiumTier !== 'ALL',
        allowedPlanIds: savedAccess.allowedPlanIds ?? [],
        // The VIP system is removed for now (D-11).
        requireVip: false,
        minKycLevel: type === 'KYC' ? Math.max(1, savedAccess.minKycLevel ?? 1) : (savedAccess.minKycLevel ?? 0),
        minLevel: Number(minLevel) || 0,
        minWagerUsd: type === 'CASINO' && casinoMinWagerUsd ? String(casinoMinWagerUsd) : null,
        ineligibleMode: ineligibleBehavior || (type === 'STAFF' || type === 'SO' ? 'HIDE' : 'VIEW_ONLY'),
        // The visibility audience is its own admin choice; editing other fields never changes it (C-11).
        visibility: savedAccess.visibility ?? { groups: [], minLevel: 0 },
      },
      accessSettings: {
        requirePremium: type === 'PREMIUM' || type === 'VIP' || requireVip || premiumTier !== 'ALL',
        requireVip: type === 'PREMIUM' || type === 'VIP' || requireVip,
        requireKyc: type === 'KYC' || requireKyc,
        requireMerchant: type === 'SO' || requireMerchant,
        minLevel: Number(minLevel) || 0,
        minWagerUsd: type === 'CASINO' ? Number(casinoMinWagerUsd) || 0 : Number(minWagerUsd) || 0,
        allowedCountries,
        viewOnlyCountries,
        ineligibleBehavior,
        isViewOnlyForOthers: ineligibleBehavior !== 'HIDE',
        premiumTier,
      },
    });

    onClose();
  };

  if (!isOpen || !room) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-dialog" style={{ maxWidth: '820px', width: '92%', maxHeight: '90vh' }}>
        <div className="modal-header" style={{ padding: '16px 20px' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Manage Room: {room.name}</h3>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close modal">✕</button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <div className="modal-body" style={{ overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            
            {/* CATEGORY SELECTOR */}
            <div>
              <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px', display: 'block' }}>
                Room Category
              </label>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {CATEGORIES.map((cat) => {
                  const isSelected = type === cat.type;
                  return (
                    <button
                      key={cat.type}
                      type="button"
                      onClick={() => setType(cat.type)}
                      style={{
                        padding: '6px 14px',
                        borderRadius: '6px',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: 'pointer',
                        border: isSelected ? '1px solid var(--primary)' : '1px solid var(--border)',
                        background: isSelected ? 'rgba(0, 242, 254, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                        color: isSelected ? 'var(--primary)' : 'var(--text-secondary)',
                      }}
                    >
                      {cat.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* CORE IDENTITY */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '12px' }}>
              <div className="form-group">
                <label>Room Name *</label>
                <input
                  type="text"
                  className="form-control"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label>Status</label>
                <select
                  className="form-control"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as any)}
                >
                  <option value="ACTIVE">Active</option>
                  <option value="MAINTENANCE">Maintenance</option>
                  <option value="DISABLED">Disabled</option>
                </select>
                {status === 'MAINTENANCE' && (
                  <input
                    className="form-control"
                    style={{ marginTop: '6px' }}
                    placeholder="Maintenance note shown to users, e.g. Back soon"
                    maxLength={300}
                    value={statusNote}
                    onChange={(e) => setStatusNote(e.target.value)}
                  />
                )}
                <label style={{ marginTop: '6px', fontSize: '11px' }}>Apply at (empty = now)</label>
                <input
                  type="datetime-local"
                  className="form-control"
                  value={effectiveAt}
                  onChange={(e) => setEffectiveAt(e.target.value)}
                />
              </div>
            </div>

            {/* SLUG */}
            <div className="form-group" style={{ margin: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <label style={{ margin: 0 }}>Slug Route *</label>
                <button
                  type="button"
                  onClick={() => setIsSlugLocked(!isSlugLocked)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--primary)',
                    fontSize: '11px',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                >
                  {isSlugLocked ? 'Unlock Custom' : 'Auto-Sync'}
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <span style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  padding: '7px 10px',
                  border: '1px solid var(--border)',
                  borderRight: 'none',
                  borderRadius: '4px 0 0 4px',
                  color: 'var(--text-muted)',
                  fontSize: '12px',
                  fontFamily: 'monospace',
                }}>
                  orebit.io/chat/
                </span>
                <input
                  type="text"
                  className="form-control"
                  style={{
                    borderRadius: '0 4px 4px 0',
                    fontFamily: 'monospace',
                    fontWeight: 600,
                    color: 'var(--primary)',
                  }}
                  value={slug}
                  onChange={(e) => {
                    setIsSlugLocked(true);
                    setSlug(cleanSlug(e.target.value));
                  }}
                  required
                />
              </div>
            </div>

            {/* CONDITIONAL SETTINGS BY CATEGORY */}
            <div style={{
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '14px',
            }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
                {type} Configuration
              </div>

              {/* GLOBAL */}
              {type === 'GLOBAL' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Min Player Level (0 = Open)</label>
                    <input
                      type="number"
                      min={0}
                      className="form-control"
                      value={minLevel}
                      onChange={(e) => setMinLevel(Number(e.target.value))}
                    />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Language</label>
                    <select className="form-control" value={language} onChange={(e) => setLanguage(e.target.value)}>
                      {LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>{l.name} ({l.code})</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {/* LANGUAGE */}
              {type === 'LANGUAGE' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Min Player Level (0 = Open)</label>
                    <input
                      type="number"
                      min={0}
                      className="form-control"
                      value={minLevel}
                      onChange={(e) => setMinLevel(Number(e.target.value))}
                    />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Language *</label>
                    <select className="form-control" value={language} onChange={(e) => setLanguage(e.target.value)}>
                      {LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>{l.name} ({l.code})</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {/* CASINO */}
              {type === 'CASINO' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '12px' }}>Auto-Switch when Casino Game Opens</span>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={casinoAutoSwitch}
                        onChange={(e) => setCasinoAutoSwitch(e.target.checked)}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '12px' }}>Switch Even if Private DM is Open</span>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={casinoSwitchIfDmOpen}
                        onChange={(e) => setCasinoSwitchIfDmOpen(e.target.checked)}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '12px' }}>Require Active Casino Game Session to Chat</span>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={casinoRequireOpen}
                        onChange={(e) => setCasinoRequireOpen(e.target.checked)}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '4px' }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label>Min Turnover / Wager ($)</label>
                      <input
                        type="number"
                        min={0}
                        step="any"
                        className="form-control"
                        value={casinoMinWagerUsd}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setCasinoMinWagerUsd(v);
                          setMinWagerUsd(v);
                        }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '18px' }}>
                      <span style={{ fontSize: '12px' }}>Separate VIP Casino Room</span>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={casinoSeparateVip}
                          onChange={(e) => setCasinoSeparateVip(e.target.checked)}
                        />
                        <span className="toggle-slider"></span>
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {/* COUNTRY */}
              {type === 'COUNTRY' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                    {POPULAR_COUNTRIES.map((c) => (
                      <button
                        key={c.code}
                        type="button"
                        onClick={() => handleCountrySelect(c)}
                        style={{
                          padding: '3px 8px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          border: countryCode === c.code ? '1px solid var(--primary)' : '1px solid var(--border)',
                          background: countryCode === c.code ? 'rgba(0, 242, 254, 0.15)' : 'rgba(255, 255, 255, 0.02)',
                          color: countryCode === c.code ? 'var(--primary)' : 'var(--text-secondary)',
                          cursor: 'pointer',
                        }}
                      >
                        {c.name} ({c.code})
                      </button>
                    ))}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label>Country *</label>
                      <select
                        className="form-control"
                        value={countryCode}
                        onChange={(e) => {
                          const code = e.target.value;
                          setCountryCode(code);
                          setAllowedCountriesList(code ? [code] : []);
                        }}
                        required
                      >
                        <option value="">Select a country...</option>
                        {COUNTRIES.map((c) => (
                          <option key={c.code} value={c.code}>{c.name} ({c.code})</option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group" style={{ margin: 0 }}>
                      <label>Language</label>
                      <select className="form-control" value={language} onChange={(e) => setLanguage(e.target.value)}>
                        {LANGUAGES.map((l) => (
                          <option key={l.code} value={l.code}>{l.name} ({l.code})</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '4px' }}>
                    <span style={{ fontSize: '12px' }}>Separate VIP Sub-Room for this Country</span>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={separateRegionVip}
                        onChange={(e) => setSeparateRegionVip(e.target.checked)}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                  </div>
                </div>
              )}

              {/* REGION */}
              {type === 'REGION' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label>Continent / Region</label>
                      <select
                        className="form-control"
                        value={continent}
                        onChange={(e) => setContinent(e.target.value)}
                      >
                        {CONTINENTS.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group" style={{ margin: 0 }}>
                      <label>Language</label>
                      <select className="form-control" value={language} onChange={(e) => setLanguage(e.target.value)}>
                        {LANGUAGES.map((l) => (
                          <option key={l.code} value={l.code}>{l.name} ({l.code})</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Allowed Countries</label>
                    <CountryMultiSelect
                      options={COUNTRIES}
                      value={allowedCountriesList}
                      onChange={setAllowedCountriesList}
                      placeholder="Select countries in this region..."
                    />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '4px' }}>
                    <span style={{ fontSize: '12px' }}>Separate Regional VIP Room</span>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={separateRegionVip}
                        onChange={(e) => setSeparateRegionVip(e.target.checked)}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                  </div>
                </div>
              )}

              {/* PREMIUM / VIP */}
              {type === 'PREMIUM' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Minimum level to chat</label>
                    <input
                      type="number"
                      min={0}
                      className="form-control"
                      value={minLevel}
                      onChange={(e) => setMinLevel(Number(e.target.value))}
                    />
                  </div>

                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Min 30-Day Wager ($)</label>
                    <input
                      type="number"
                      min={0}
                      step={500}
                      className="form-control"
                      value={minWagerUsd}
                      onChange={(e) => setMinWagerUsd(Number(e.target.value))}
                    />
                  </div>
                </div>
              )}

              {/* KYC */}
              {type === 'KYC' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>KYC Level Requirement</label>
                    <select className="form-control" defaultValue="TIER_1">
                      <option value="TIER_1">Tier 1 Verified</option>
                      <option value="TIER_2">Tier 2 Full ID</option>
                    </select>
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Language</label>
                    <select className="form-control" value={language} onChange={(e) => setLanguage(e.target.value)}>
                      {LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>{l.name} ({l.code})</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {/* SO */}
              {type === 'SO' && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '12px' }}>Separate Partner VIP Room</span>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={soSeparateVip}
                      onChange={(e) => setSoSeparateVip(e.target.checked)}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>
              )}

              {/* STAFF */}
              {type === 'STAFF' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Role Clearance</label>
                    <select className="form-control" defaultValue="MODERATOR">
                      <option value="MODERATOR">Moderator &amp; Above</option>
                      <option value="ADMIN">Admin Only</option>
                    </select>
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Language</label>
                    <select className="form-control" value={language} onChange={(e) => setLanguage(e.target.value)}>
                      {LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>{l.name} ({l.code})</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {/* GEOGRAPHIC RESTRICTION — every type except GLOBAL (unrestricted by
                  definition) and COUNTRY/REGION (which have their own geo fields
                  above). Backend enforcement (`evaluateRoomAccess`, step 5) checks
                  `allowedCountries` for ANY room type, not just COUNTRY/REGION — so
                  e.g. a VIP or Casino room can be restricted to specific countries
                  too, same as a plain Country/Region room. */}
              {type !== 'GLOBAL' && type !== 'COUNTRY' && type !== 'REGION' && (
                <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--border)' }}>
                  <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '8px' }}>
                    Geographic Restriction (Optional)
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label>Continent / Region</label>
                      <select className="form-control" value={continent} onChange={(e) => setContinent(e.target.value)}>
                        {CONTINENTS.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label>Allowed Countries</label>
                      <CountryMultiSelect options={COUNTRIES} value={allowedCountriesList} onChange={setAllowedCountriesList} />
                    </div>
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    Leave empty to allow every country.
                  </div>
                </div>
              )}

              {/* PREMIUM TIER GATE — independent of category, any room (Casino
                  included) can require a minimum subscription tier. */}
              <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--border)' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>
                  Premium Tier Required
                </label>
                <select
                  className="form-control"
                  value={premiumTier}
                  onChange={(e) => setPremiumTier(e.target.value as PremiumTier)}
                >
                  <option value="ALL">Any Tier (No Requirement)</option>
                  <option value="BASIC">Basic Premium &amp; Above</option>
                  <option value="MEDIUM">Medium Premium &amp; Above</option>
                  <option value="TOP">Top Premium Only</option>
                </select>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  Gates this room by subscription tier, on top of any level/wager requirement above.
                </div>
              </div>

              {/* INELIGIBLE POSTURE */}
              <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--border)' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>
                  Non-Qualifying User Posture
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {[
                    { key: 'VIEW_ONLY', label: 'View Only' },
                    { key: 'PROMO_ONLY', label: 'Promo Teaser' },
                    { key: 'HIDE', label: 'Hidden from List' },
                  ].map((pos) => (
                    <button
                      key={pos.key}
                      type="button"
                      onClick={() => setIneligibleBehavior(pos.key as any)}
                      style={{
                        flex: 1,
                        padding: '6px',
                        borderRadius: '4px',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: 'pointer',
                        border: ineligibleBehavior === pos.key ? '1px solid var(--primary)' : '1px solid var(--border)',
                        background: ineligibleBehavior === pos.key ? 'rgba(0, 242, 254, 0.12)' : 'rgba(255, 255, 255, 0.02)',
                        color: ineligibleBehavior === pos.key ? 'var(--primary)' : 'var(--text-secondary)',
                      }}
                    >
                      {pos.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* MEDIA & MODERATION */}
            <div style={{
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '14px',
            }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '10px' }}>
                Permissions &amp; Moderation
              </div>

              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '12px' }}>
                {[
                  { key: 'Text', val: allowText, set: setAllowText },
                  { key: 'GIF', val: allowGif, set: setAllowGif },
                  { key: 'Image', val: allowImage, set: setAllowImage },
                  { key: 'Video', val: allowVideo, set: setAllowVideo },
                  { key: 'Emoji', val: allowEmoji, set: setAllowEmoji },
                ].map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => item.set(!item.val)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      border: item.val ? '1px solid var(--primary)' : '1px solid var(--border)',
                      background: item.val ? 'rgba(0, 242, 254, 0.1)' : 'rgba(255, 255, 255, 0.02)',
                      color: item.val ? 'var(--primary)' : 'var(--text-muted)',
                    }}
                  >
                    {item.key}: {item.val ? 'Allowed' : 'Off'}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Under maintenance:</span>
                {['TEXT', 'EMOJI', 'GIF', 'IMAGE', 'VIDEO', 'COMMANDS', 'ADS'].map((c) => {
                  const on = controlsMaintenance.includes(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setControlsMaintenance(on ? controlsMaintenance.filter((x) => x !== c) : [...controlsMaintenance, c])}
                      style={{
                        padding: '4px 10px',
                        borderRadius: '4px',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: 'pointer',
                        border: on ? '1px solid #fbbf24' : '1px solid var(--border)',
                        background: on ? 'rgba(251, 191, 36, 0.12)' : 'rgba(255, 255, 255, 0.02)',
                        color: on ? '#fbbf24' : 'var(--text-muted)',
                      }}
                    >
                      {c}
                    </button>
                  );
                })}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', alignItems: 'center' }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label>Links Policy</label>
                  <select
                    className="form-control"
                    value={linksPolicy}
                    onChange={(e) => setLinksPolicy(e.target.value as any)}
                  >
                    <option value="ALL_LINKS">All Links Allowed</option>
                    <option value="OREBIT_ONLY">Orebit Links Only</option>
                    <option value="NO_LINKS">No Links Allowed</option>
                  </select>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '16px' }}>
                  <span style={{ fontSize: '12px' }}>Auto-Moderation</span>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={autoModeration} onChange={(e) => setAutoModeration(e.target.checked)} />
                    <span className="toggle-slider"></span>
                  </label>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '16px' }}>
                  <span style={{ fontSize: '12px' }}>Commands</span>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={allowCommands} onChange={(e) => setAllowCommands(e.target.checked)} />
                    <span className="toggle-slider"></span>
                  </label>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '16px' }}>
                  <span style={{ fontSize: '12px' }}>Ads</span>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={adsAllowed} onChange={(e) => setAdsAllowed(e.target.checked)} />
                    <span className="toggle-slider"></span>
                  </label>
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label>Visibility</label>
                  <select
                    className="form-control"
                    value={visibility}
                    onChange={(e) => setVisibility(e.target.value as typeof visibility)}
                  >
                    <option value="ALL">All Users</option>
                    <option value="PREMIUM">Premium Only</option>
                    <option value="VIP">VIP Only</option>
                    <option value="STAFF">Staff Only</option>
                    <option value="KYC">KYC Verified Only</option>
                  </select>
                </div>
              </div>
            </div>

            {/* RULES */}
            <div style={{
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '14px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Community Rules ({rules.length})
                </span>
                <button
                  type="button"
                  onClick={() => setRules(PRESET_RULES[type] || [])}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--primary)',
                    fontSize: '11px',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                >
                  Reset to {type} Presets
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {rules.map((rule, idx) => (
                  <div key={idx} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', width: '16px', textAlign: 'right' }}>
                      {idx + 1}.
                    </span>
                    <input
                      type="text"
                      className="form-control"
                      value={rule}
                      placeholder={`Rule ${idx + 1}...`}
                      onChange={(e) => handleRuleChange(idx, e.target.value)}
                      style={{ flex: 1, padding: '5px 10px', fontSize: '12px' }}
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveRule(idx)}
                      style={{
                        background: 'none',
                        border: '1px solid var(--border)',
                        color: 'var(--danger)',
                        borderRadius: '4px',
                        width: '24px',
                        height: '24px',
                        cursor: 'pointer',
                        fontSize: '11px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={handleAddRule}
                style={{
                  marginTop: '8px',
                  background: 'none',
                  border: '1px dashed var(--border)',
                  borderRadius: '4px',
                  padding: '6px',
                  color: 'var(--text-secondary)',
                  fontSize: '11px',
                  cursor: 'pointer',
                  width: '100%',
                }}
              >
                + Add Rule
              </button>
            </div>

          </div>

          <div className="modal-footer" style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '12px 20px',
            borderTop: '1px solid var(--border)',
            background: 'rgba(7, 9, 14, 0.8)',
          }}>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              /{slug || 'slug'}
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" className="btn-secondary" onClick={onClose} style={{ padding: '6px 14px', fontSize: '12px' }}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={!name.trim()} style={{ padding: '6px 16px', fontSize: '12px' }}>
                Save Changes
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
