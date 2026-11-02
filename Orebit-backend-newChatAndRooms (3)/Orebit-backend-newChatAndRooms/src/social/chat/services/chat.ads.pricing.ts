// The price of an ad, from Chat SETTINGS "/Ad" (Module 5). Pure, decimal arithmetic only (never floats for money).
// - One post costs the base price, plus each room after the first ("Per Extra Room add cost"), with premium and SO
// rooms at their own add cost; choosing ALL rooms replaces the per-room costs with "ALL Rooms Cost", premium and
// SO rooms still "added separately". When "ALL Rooms" is the default there are no room costs at all.
// - Links: the first `maxFreeLinks` are free, then `pricePerExtraLink` each up to `maxPaidLinks`; more is refused.
// - Every "+x %" is taken of the running total, in the order the lines appear (Base.md "applied in compound"): a
// 100 USD ad with +10 % and then +20 % costs 100 × 1.10 × 1.20 = 132, not 130. A "+y USD" adds y.
// - Repeats cost one post each, less ONE flat "Discount percentage (per repeat)" that never exceeds the one
// maximum discount (percent, and USD when set).
// - Pinning costs "x% or y USD / min" once per ad per minute, however many rooms it is pinned in.
// - "ALL Rooms" also shows what the same rooms cost one by one and the saving.
// Every result is cut (never rounded) to 8 decimals.
import { minOf, money, percentOf, shareOf, usdStored, type Money } from '../platform/money';
import type { RoomType } from '../chat.contract';
import type { PriceAdd } from '../chat.features.contract';
import type { ChatSettings } from '../chat.settings.contract';

type AdSettings = ChatSettings['ads'];
const D = money;
const out = usdStored;

export interface AdPriceInput {
  // `planBound`: a premium room of particular plans ("Sub Premium Room").
  readonly rooms: readonly {
    readonly id: string;
    readonly type: RoomType;
    readonly planBound?: boolean;
  }[];
  // "Ad Skins: Price: x USD", once per ad.
  readonly skinPriceUsd?: string | null;
  readonly allRooms: boolean;
  readonly links: number;
  readonly repeatCount: number;
  readonly pinMinutes: number | null;
  // "18+ Advertisements".
  readonly is18Plus?: boolean;
  // Loyalty/coupon/VIP discount from BenefitDiscountPort.
  readonly benefitDiscountUsd?: string | null;
}

export interface AdPriceLine {
  readonly label: string;
  readonly usd: string;
}

export interface AdPrice {
  readonly perPostUsd: string;
  readonly totalUsd: string;
  readonly lines: readonly AdPriceLine[];
  // "ALL Rooms" only: the same ad with each room added separately, and what ALL Rooms saves (never below 0).
  readonly separateTotalUsd?: string;
  readonly savedUsd?: string;
}

export class AdPriceError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

// "+x% or y USD": a percentage is taken of `running`, the price built up so far (compound); USD is flat.
export function addCost(add: PriceAdd, running: Money): Money {
  return add.kind === 'USD' ? D(add.value) : percentOf(running, add.value);
}

function roomAdd(ads: AdSettings, type: RoomType, planBound = false): PriceAdd | null {
  if (type === 'PREMIUM') return planBound ? ads.subPremiumRoom : ads.premiumRoom;
  if (type === 'SO') return ads.soRoom;
  return null;
}

function roomLabel(type: RoomType, planBound = false): string {
  if (type === 'SO') return 'Site Owner room';
  return planBound ? 'Sub premium room' : 'Premium room';
}

// The discount of one repeat: one flat percentage, the same for every repeat, under the maximum discount.
export function repeatDiscount(ads: AdSettings, perPost: Money): Money {
  const percent = minOf(D(ads.repeat.discountPercent), ads.repeat.maxDiscountPercent);
  const off = percentOf(perPost, percent);
  return ads.repeat.maxDiscountUsd === null ? off : minOf(off, ads.repeat.maxDiscountUsd);
}

export function priceAd(ads: AdSettings, input: AdPriceInput): AdPrice {
  const base = D(ads.basePriceUsd);
  const lines: AdPriceLine[] = [{ label: 'Base price', usd: out(base) }];
  let perPost = base;
  const rooms = [...input.rooms].sort((left, right) => {
    const leftAdd = roomAdd(ads, left.type, left.planBound);
    const rightAdd = roomAdd(ads, right.type, right.planBound);
    const priority = Number(Boolean(leftAdd)) - Number(Boolean(rightAdd));
    return priority || left.type.localeCompare(right.type) || left.id.localeCompare(right.id);
  });

  if (input.is18Plus) {
    if (!ads.allow18Plus) {
      throw new AdPriceError('is18Plus', '18+ advertisements are not allowed');
    }
    if (D(ads.extra18PlusPercent).gt(0)) {
      const extra18 = percentOf(base, ads.extra18PlusPercent);
      lines.push({ label: '18+ advert surcharge', usd: out(extra18) });
      perPost = perPost.add(extra18);
    }
  }

  if (!ads.allRoomsByDefault) {
    if (input.allRooms) {
      const all = addCost(ads.allRooms, perPost);
      lines.push({ label: 'All rooms', usd: out(all) });
      perPost = perPost.add(all);
      for (const room of rooms) {
        const add = roomAdd(ads, room.type, room.planBound);
        if (!add) continue;
        const cost = addCost(add, perPost);
        lines.push({
          label: roomLabel(room.type, room.planBound),
          usd: out(cost),
        });
        perPost = perPost.add(cost);
      }
    } else {
      rooms.forEach((room, index) => {
        const add = roomAdd(ads, room.type, room.planBound);
        // The first ordinary room is in the base price; premium and SO rooms always add their own cost.
        if (!add && index === 0) return;
        const cost = addCost(add ?? ads.extraRoom, perPost);
        lines.push({
          label: add ? roomLabel(room.type, room.planBound) : 'Extra room',
          usd: out(cost),
        });
        perPost = perPost.add(cost);
      });
    }
  }

  if (input.links > ads.maxFreeLinks + ads.maxPaidLinks) {
    throw new AdPriceError(
      'content',
      `At most ${ads.maxFreeLinks + ads.maxPaidLinks} links in an ad (${ads.maxFreeLinks} free)`,
    );
  }
  const paidLinks = Math.max(0, input.links - ads.maxFreeLinks);
  if (paidLinks > 0) {
    // Each paid link is its own step, so a percentage compounds link after link.
    const before = perPost;
    for (let i = 0; i < paidLinks; i += 1) perPost = perPost.add(addCost(ads.pricePerExtraLink, perPost));
    lines.push({
      label: `${paidLinks} extra link${paidLinks === 1 ? '' : 's'}`,
      usd: out(perPost.sub(before)),
    });
  }

  let total = perPost;
  let repeatDiscountUsed = D(0);
  for (let k = 1; k <= input.repeatCount; k += 1) {
    const perRepeat = repeatDiscount(ads, perPost);
    const cap = ads.repeat.maxDiscountUsd;
    const remainingCap = cap === null ? null : D(cap).sub(repeatDiscountUsed);
    const off = remainingCap === null ? perRepeat : minOf(perRepeat, remainingCap.gt(0) ? remainingCap : D(0));
    const cost = perPost.sub(off);
    repeatDiscountUsed = repeatDiscountUsed.add(off);
    lines.push({ label: `Repeat ${k}`, usd: out(cost) });
    total = total.add(cost);
  }

  if (input.skinPriceUsd && D(input.skinPriceUsd).gt(0)) {
    lines.push({ label: 'Ad skin', usd: out(D(input.skinPriceUsd)) });
    total = total.add(D(input.skinPriceUsd));
  }

  if (input.pinMinutes !== null && input.pinMinutes > 0) {
    // Once per ad per minute, not per room; a percentage is of the base price.
    const cost = addCost(ads.pinned.pricePerMinute, base).mul(input.pinMinutes);
    lines.push({ label: `Pinned ${input.pinMinutes} min`, usd: out(cost) });
    total = total.add(cost);
  }

  if (input.benefitDiscountUsd && D(input.benefitDiscountUsd).gt(0)) {
    const disc = D(input.benefitDiscountUsd);
    lines.push({ label: 'Benefit discount', usd: `-${out(disc)}` });
    total = total.sub(disc);
    if (total.lt(0)) total = D(0);
  }

  const price: AdPrice = { perPostUsd: out(perPost), totalUsd: out(total), lines };
  if (!input.allRooms || ads.allRoomsByDefault) return price;
  // "Show discounted when compared to adding each room separately".
  const separate = priceAd(ads, { ...input, allRooms: false });
  const saved = D(separate.totalUsd).sub(total);
  return {
    ...price,
    separateTotalUsd: separate.totalUsd,
    savedUsd: out(saved.gt(0) ? saved : D(0)),
  };
}

// What an ad has not used yet, in whole seconds: posts not made plus pinned time not shown.
export interface UnusedParts {
  readonly unused: number;
  readonly units: number;
}

// What an ad has not used yet: the posts not made and the pinned minutes not shown ("fully refund the advertiser only
// for Pending / uncompleted views, not the utilised ones"). Whole numbers, so the share is exact.
export function unusedParts(input: {
  totalPosts: number;
  postedCount: number;
  pinnedMinutes: number;
  pinnedSecondsUsed: number;
}): UnusedParts {
  return {
    units: (input.totalPosts + input.pinnedMinutes) * 60,
    unused:
      Math.max(0, input.totalPosts - input.postedCount) * 60 +
      Math.max(0, input.pinnedMinutes * 60 - input.pinnedSecondsUsed),
  };
}

// The refund for what is unused: the price times unused/units, cut (never rounded) to 8 places.
export function unusedRefundUsd(priceUsd: string, parts: UnusedParts): string {
  return parts.units === 0 ? usdStored(0) : usdStored(shareOf(priceUsd, parts.unused, parts.units));
}

// The refund of an ad that is cancelled before it ended, from what it has shown so far, less optional cancellation fee.
export function refundForCancel(
  ad: {
    readonly priceUsd: string;
    readonly repeatCount: number;
    readonly postedCount: number;
    readonly pinMinutes: number | null;
    readonly roomIds: readonly string[];
  },
  pinnedSecondsUsed: number,
  fee?: PriceAdd | null,
): string {
  // The pinned minutes were charged once per ad, so they are refunded once per ad, not per room.
  const pinnedMinutes = ad.pinMinutes ?? 0;
  const raw = unusedRefundUsd(
    ad.priceUsd,
    unusedParts({
      totalPosts: ad.repeatCount + 1,
      postedCount: ad.postedCount,
      pinnedMinutes,
      pinnedSecondsUsed,
    }),
  );
  if (!fee || !D(raw).gt(0)) return raw;
  const feeAmount = addCost(fee, D(raw));
  const finalRefund = D(raw).sub(feeAmount);
  return usdStored(finalRefund.gt(0) ? finalRefund : D(0));
}

// Advertisers can only stop posts before the first post is sent. Pins are a separate service and always run to
// their booked end, so their minutes never enter this refund. Admin/maintenance refunds keep refundForCancel above.
export function refundForAdvertiserStop(
  ad: { readonly priceUsd: string; readonly repeatCount: number; readonly breakdown?: unknown },
  fee?: PriceAdd | null,
): string {
  const lines = Array.isArray(ad.breakdown) ? ad.breakdown : [];
  const postPrice = lines.reduce((total, line) => {
    if (!line || typeof line !== 'object') return total;
    const item = line as { label?: unknown; usd?: unknown };
    if (typeof item.label !== 'string' || typeof item.usd !== 'string') return total;
    if (/^Pinned\b|^Ad skin$/.test(item.label)) return total;
    return total.add(D(item.usd));
  }, D(0));
  // Old rows without an itemized breakdown are conservatively non-refundable rather than refunding pin/skin spend.
  const raw = usdStored(postPrice);
  if (!fee || !D(raw).gt(0)) return raw;
  const finalRefund = D(raw).sub(addCost(fee, D(raw)));
  return usdStored(finalRefund.gt(0) ? finalRefund : D(0));
}
