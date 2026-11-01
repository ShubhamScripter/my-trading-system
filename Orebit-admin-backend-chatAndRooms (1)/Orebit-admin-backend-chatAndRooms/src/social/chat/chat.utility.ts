/**
 * Small helpers for the admin chat code: UUID checks, slugs and new ids.
 */
import { uuidv7 } from '../../utils/public.utils';

export const ChatUtility = {
  isValidUuid(val?: string | null): boolean {
    if (!val) return false;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(val);
  },

  slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/[\s-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  },

  generateUuid(): string {
    return uuidv7();
  },
};
