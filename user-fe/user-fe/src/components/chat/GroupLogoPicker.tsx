'use client';

/**
 * A group logo: the image is uploaded through chat first (POST /social/chat/upload), because the server accepts only
 * chat upload URLs as a group logo.
 */
import React, { useRef, useState } from 'react';
import { Image as ImageIcon, Loader2, X } from 'lucide-react';
import { uploadMedia } from '@/lib/api/messages';

interface Props {
  value: string;
  onChange: (url: string) => void;
}

export default function GroupLogoPicker({ value, onChange }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Choose an image');
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const uploaded = await uploadMedia('', file);
      onChange(uploaded.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: '12px',
            border: '1px solid var(--border-color, #232734)',
            background: 'var(--bg-input, #0d0f15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element -- signed chat upload URL
            <img src={value} alt="Group logo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <ImageIcon size={20} color="#64748b" />
          )}
        </div>
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={uploading}
          style={{
            background: 'transparent',
            border: '1px solid var(--border-color, #232734)',
            color: '#e2e8f0',
            borderRadius: '8px',
            padding: '0.45rem 0.8rem',
            fontSize: '0.8rem',
            cursor: uploading ? 'wait' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
          }}
        >
          {uploading && <Loader2 size={14} className="animate-spin" />}
          {value ? 'Change image' : 'Upload image'}
        </button>
        {value && !uploading && (
          <button
            type="button"
            onClick={() => onChange('')}
            title="Remove"
            style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}
          >
            <X size={16} />
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => void pick(e.target.files?.[0])}
        />
      </div>
      {error && <div style={{ color: '#f87171', fontSize: '0.75rem', marginTop: '0.35rem' }}>{error}</div>}
    </div>
  );
}
