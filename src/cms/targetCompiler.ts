// Compiles trigger images into one MindAR target file, in the admin's
// browser, with the same MindAR build the scanner runs. Browser only.
//
// Nothing here uploads or writes anything. The result stays in memory until
// targetPackService.saveCompiledPack() is called.

import { sha256Hex } from './fileInspect';
import { MINDAR_COMPILER_VERSION } from './manifest';
import { resolveObjectUrl, type ObjectRef } from './storage';
import {
  checkPackSize,
  computeSourceHash,
  summarizeTargets,
  verifyCompiledTargets,
  type CompileSource,
  type CompiledTarget,
} from './targetPack';

export type CompiledPack = {
  bytes: Uint8Array;
  sha256: string;
  sourceHash: string;
  compilerVersion: string;
  // The exact compiler input, in order. Index in this list = targetIndex.
  sources: CompileSource[];
  // What the compiler produced, read back from `bytes`, in the same order.
  targets: CompiledTarget[];
  durationMs: number;
};

export type CompileProgress = {
  phase: 'loading' | 'compiling' | 'verifying';
  // 0 to 100 within the phase.
  percent: number;
  detail: string;
};

// The MindAR compiler reports progress but never reports a failure: an error
// inside it leaves its promise pending forever. No progress for this long is
// treated as a failure. One step on a very large image can take a while.
const STALL_TIMEOUT_MS = 3 * 60 * 1000;

const SOURCE_FETCH_TIMEOUT_MS = 60 * 1000;

function decodeImage(blob: Blob, label: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`${label}: the stored trigger could not be decoded as an image.`));
    };
    image.src = url;
  });
}

// How the compiler gets the bytes of one trigger. Passed in, so the compile
// itself knows nothing about where files are stored.
export type SourceLoader = (source: CompileSource) => Promise<Blob>;

// The loader the admin uses: a private trigger source, read through the
// StorageAdapter with a short-lived signed URL.
export function storageSourceLoader(refs: Map<string, ObjectRef>): SourceLoader {
  return async (source) => {
    const ref = refs.get(source.triggerMediaId);

    if (!ref) {
      throw new Error('the trigger file record is missing.');
    }

    const response = await fetch(await resolveObjectUrl(ref), {
      cache: 'no-store',
      signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
    }).catch(() => null);

    if (!response?.ok) {
      throw new Error('the trigger image could not be downloaded.');
    }

    return response.blob();
  };
}

// Gets one trigger source and proves it is the file the database describes:
// same bytes (SHA-256) and same pixel size.
async function loadSource(
  source: CompileSource,
  load: SourceLoader,
): Promise<HTMLImageElement> {
  const label = `Target ${source.targetIndex} (${source.artworkName})`;
  const blob = await load(source).catch((reason: unknown) => {
    throw new Error(
      `${label}: ${reason instanceof Error ? reason.message : 'the trigger image could not be read.'}`,
    );
  });

  if ((await sha256Hex(blob)) !== source.sha256) {
    throw new Error(
      `${label}: the stored trigger does not match its recorded hash. Upload the trigger again.`,
    );
  }

  const image = await decodeImage(blob, label);

  if (image.naturalWidth !== source.width || image.naturalHeight !== source.height) {
    throw new Error(
      `${label}: the stored trigger is ${image.naturalWidth} x ${image.naturalHeight} but ${source.width} x ${source.height} was recorded. Upload the trigger again.`,
    );
  }

  return image;
}

type CompilerInstance = {
  compileImageTargets(
    images: HTMLImageElement[],
    onProgress: (percent: number) => void,
  ): Promise<unknown[]>;
  exportData(): Uint8Array;
  importData(buffer: Uint8Array): unknown[];
};

// Runs the compile and turns "no progress" and stray errors into a rejection.
function compileWithWatchdog(
  compiler: CompilerInstance,
  images: HTMLImageElement[],
  onPercent: (percent: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer = 0;

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener('unhandledrejection', handleRejection);

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const stalled = () =>
      finish(
        new Error(
          'The compiler stopped responding. Reload the page and try again, on a computer rather than a phone.',
        ),
      );

    // The compiler runs its work inside an async promise executor, so an
    // error there surfaces only as an unhandled rejection.
    const handleRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason as { message?: string } | undefined;

      finish(new Error(`The compiler failed: ${reason?.message ?? String(event.reason)}`));
    };

    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(stalled, STALL_TIMEOUT_MS);
    };

    window.addEventListener('unhandledrejection', handleRejection);
    arm();

    compiler
      .compileImageTargets(images, (percent) => {
        arm();
        onPercent(Math.max(0, Math.min(100, percent)));
      })
      .then(
        () => finish(),
        (error: unknown) =>
          finish(error instanceof Error ? error : new Error(String(error))),
      );
  });
}

// sources: from orderCompileSources(). load: see storageSourceLoader().
export async function compileTargetPack(
  sources: CompileSource[],
  load: SourceLoader,
  onProgress: (progress: CompileProgress) => void,
): Promise<CompiledPack> {
  if (sources.length === 0) {
    throw new Error('There are no Ready artworks with a trigger image to compile.');
  }

  if (!window.isSecureContext || !crypto.subtle) {
    throw new Error('Compiling needs HTTPS. Open the admin over https://.');
  }

  const startedAt = performance.now();
  const images: HTMLImageElement[] = [];

  // One at a time, in order: the position in `images` is the targetIndex.
  for (const source of sources) {
    onProgress({
      phase: 'loading',
      percent: (source.targetIndex / sources.length) * 100,
      detail: `Checking trigger ${source.targetIndex + 1} of ${sources.length}: ${source.artworkName}`,
    });

    images.push(await loadSource(source, load));
  }

  // The scanner loads the same MindAR code file, so this adds no second copy
  // of MindAR to the site.
  const { Compiler } = await import('mind-ar/dist/mindar-image.prod.js');
  const compiler: CompilerInstance = new Compiler();

  onProgress({ phase: 'compiling', percent: 0, detail: 'Compiling...' });

  await compileWithWatchdog(compiler, images, (percent) =>
    onProgress({
      phase: 'compiling',
      percent,
      detail: `Compiling ${sources.length} targets...`,
    }),
  );

  onProgress({ phase: 'verifying', percent: 0, detail: 'Verifying the compiled file...' });

  const bytes = compiler.exportData();

  // Storage would refuse a file over its upload limit. Say so now, with a
  // reason, instead of failing at the upload step.
  const tooLarge = checkPackSize(bytes.byteLength);

  if (tooLarge) {
    throw new Error(tooLarge);
  }

  // Read the file back with MindAR's own parser, the one the scanner uses to
  // load a .mind file, instead of trusting the compiler's in-memory state.
  const targets = summarizeTargets(new Compiler().importData(bytes));
  const problems = verifyCompiledTargets(sources, targets);

  if (problems.length > 0) {
    throw new Error(`The compiled file failed verification. ${problems.join(' ')}`);
  }

  return {
    bytes,
    // A copy with its own buffer: `bytes` may be a view into a larger one.
    sha256: await sha256Hex(new Blob([bytes.slice()])),
    sourceHash: await computeSourceHash(sources, MINDAR_COMPILER_VERSION),
    compilerVersion: MINDAR_COMPILER_VERSION,
    sources,
    targets,
    durationMs: performance.now() - startedAt,
  };
}
