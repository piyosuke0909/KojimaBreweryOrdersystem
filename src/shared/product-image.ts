export interface GoogleDriveImage { fileId: string; resourceKey?: string }

const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const RESOURCE_KEY = /^[A-Za-z0-9_-]{1,200}$/;

function driveUrl(input: string): URL | null {
  try {
    const url = new URL(input.trim());
    return url.protocol === 'https:' && url.hostname === 'drive.google.com' && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}

/** A Drive host is recognizable even when its path is a folder or an invalid file. */
export function isGoogleDriveUrl(input: string): boolean { return driveUrl(input) !== null; }

export function parseGoogleDriveImage(input: string): GoogleDriveImage | null {
  const url = driveUrl(input);
  if (!url) return null;
  const path = url.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]+)(?:\/(?:view|preview|edit))?\/?$/);
  let fileId: string | null = path?.[1] ?? null;
  if (!fileId && /^\/(?:open|uc|thumbnail)\/?$/.test(url.pathname)) {
    if (url.searchParams.getAll('id').length !== 1) return null;
    fileId = url.searchParams.get('id');
  }
  if (!fileId || !FILE_ID.test(fileId)) return null;
  const resourceKeys = url.searchParams.getAll('resourcekey');
  if (resourceKeys.length > 1 || (resourceKeys.length === 1 && !RESOURCE_KEY.test(resourceKeys[0]))) return null;
  return { fileId, ...(resourceKeys.length ? { resourceKey: resourceKeys[0] } : {}) };
}

/** Resolve existing saved shared links at display time; do not rewrite stored values. */
export function resolveProductImageUrl(input?: string | null): string {
  const value = input?.trim() ?? '';
  const image = parseGoogleDriveImage(value);
  if (!image) return value;
  const url = new URL('https://drive.google.com/thumbnail');
  url.searchParams.set('id', image.fileId);
  url.searchParams.set('sz', 'w1200');
  if (image.resourceKey) url.searchParams.set('resourcekey', image.resourceKey);
  return url.toString();
}
