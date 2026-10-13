// Reads the facts the CMS records about a file before it is uploaded.
// Browser only.

export type FileFacts = {
  sha256: string;
  width: number | null;
  height: number | null;
  duration: number | null;
};

const VIDEO_METADATA_TIMEOUT_MS = 15000;

export async function sha256Hex(blob: Blob): Promise<string> {
  if (!crypto.subtle) {
    throw new Error('File hashing needs HTTPS. Open the admin over https://.');
  }

  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function readImageSize(file: Blob) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This file could not be read as an image.'));
    };
    image.src = url;
  });
}

export function readVideoInfo(file: Blob) {
  return new Promise<{ width: number; height: number; duration: number | null }>(
    (resolve, reject) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');

      const finish = (error?: Error) => {
        window.clearTimeout(timeoutId);
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);

        if (error) {
          reject(error);
        }
      };

      const timeoutId = window.setTimeout(
        () => finish(new Error('This video took too long to read.')),
        VIDEO_METADATA_TIMEOUT_MS,
      );

      video.preload = 'metadata';
      video.muted = true;
      video.onloadedmetadata = () => {
        const info = {
          width: video.videoWidth,
          height: video.videoHeight,
          duration: Number.isFinite(video.duration) ? video.duration : null,
        };

        finish();
        resolve(info);
      };
      video.onerror = () =>
        finish(new Error('This browser cannot read the video file.'));
      video.src = url;
    },
  );
}

// kind: what to measure besides the hash.
export async function inspectFile(
  file: Blob,
  kind: 'image' | 'video' | 'other',
): Promise<FileFacts> {
  const sha256 = await sha256Hex(file);

  if (kind === 'image') {
    return { sha256, ...(await readImageSize(file)), duration: null };
  }

  if (kind === 'video') {
    return { sha256, ...(await readVideoInfo(file)) };
  }

  return { sha256, width: null, height: null, duration: null };
}
