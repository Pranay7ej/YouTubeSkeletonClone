// Input checks for generateUploadUrl, kept separate so they're testable
// without the Firebase runtime.

export const MAX_TITLE = 100;

const TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
};

export interface Extension {
  ext: string;
  contentType: string;
}

// Picks the extension from the file name, falling back to the MIME type.
export function pickExtension(fileName?: string, contentType?: string): Extension | null {
  const fromName = fileName?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (fromName && TYPES[fromName]) return { ext: fromName, contentType: TYPES[fromName] };
  const fromType = Object.entries(TYPES).find(([, t]) => t === contentType);
  return fromType ? { ext: fromType[0], contentType: fromType[1] } : null;
}

// "<uid>-<millis>.<ext>". The processing service derives the video id by
// dropping the extension, so both sides agree without passing ids around.
export function rawObjectName(uid: string, now: number, ext: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(uid)) throw new Error("unexpected uid format");
  return `${uid}-${now}.${ext}`;
}
