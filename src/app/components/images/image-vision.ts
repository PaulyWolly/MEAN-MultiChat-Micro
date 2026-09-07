/**
 * Vision / OpenAI helpers for browser image data URLs.
 * OpenAI accepts image/jpeg, image/png, image/gif, image/webp — not image/jpg.
 */

/** Fix non-standard MIME types so OpenAI accepts .jpg uploads. */
export function normalizeImageDataUrlMime(dataUrl: string): string {
  return String(dataUrl || '').replace(/^data:image\/jpg(;|,)/i, 'data:image/jpeg$1');
}

/**
 * Re-encode via canvas to a standard JPEG data URL.
 * Fixes CMYK / progressive / oddly tagged JPEGs that still preview in the browser
 * but OpenAI rejects as "unsupported image".
 */
export function dataUrlForVision(
  dataUrl: string,
  { maxEdge = 2048, quality = 0.88 }: { maxEdge?: number; quality?: number } = {},
): Promise<string> {
  const normalized = normalizeImageDataUrlMime(dataUrl);
  return new Promise((resolve, reject) => {
    if (!normalized.startsWith('data:image')) {
      reject(new Error('Invalid image data'));
      return;
    }
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height || 1));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas unavailable'));
        return;
      }
      // White background so transparent PNGs become valid opaque JPEGs
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      try {
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Could not encode image'));
      }
    };
    img.onerror = () => reject(new Error('Could not decode that image for analysis'));
    img.src = normalized;
  });
}

export function isLikelyImageFile(file: File): boolean {
  if (file?.type?.startsWith('image/')) return true;
  return /\.(jpe?g|png|gif|webp|bmp)$/i.test(file?.name || '');
}
