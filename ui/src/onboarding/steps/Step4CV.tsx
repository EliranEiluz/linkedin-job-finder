import { useCallback, useRef, useState } from 'react';
import { useViewport } from '../../useViewport';
import { Banner, BackButton } from '../components';
import { CV_MIN_CHARS } from '../types';

// Read an uploaded file as UTF-8 text. PDFs go through the server-side
// pypdf extractor at /api/cv/extract-pdf — FileReader.readAsText() on
// PDF binary returns gibberish. Plain-text files (.txt / .md) round-trip
// through the browser as before.
const readFileAsText = async (file: File): Promise<string> => {
  const isPdf = file.type === 'application/pdf' ||
    file.name.toLowerCase().endsWith('.pdf');
  if (isPdf) {
    const buf = await file.arrayBuffer();
    const res = await fetch('/api/cv/extract-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: buf,
    });
    const j = (await res.json().catch(() => ({}))) as
      { ok?: boolean; text?: string; error?: string };
    if (!res.ok || !j.ok || typeof j.text !== 'string') {
      throw new Error(j.error ?? `extract-pdf failed (HTTP ${res.status.toString()})`);
    }
    return j.text;
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // FileReader.result is `string | ArrayBuffer | null` after readAsText;
      // for the text reader it's always string-or-null but we coerce
      // explicitly so the `string()` path can't surface "[object …]".
      const r = reader.result;
      resolve(typeof r === 'string' ? r : '');
    };
    reader.onerror = () => { reject(reader.error ?? new Error('read failed')); };
    reader.readAsText(file);
  });
};

export const Step4CV = ({
  cv,
  setCv,
  onNext,
  onBack,
  haveExistingConfig,
}: {
  cv: string;
  setCv: (v: string) => void;
  onNext: () => void;
  onBack: () => void;
  haveExistingConfig: boolean;
}) => {
  const [pdfErr, setPdfErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = useCallback(async (file: File) => {
    setPdfErr(null);
    try {
      const text = await readFileAsText(file);
      setCv(text);
    } catch (e) {
      // Surface the real reason (image-only PDF, encrypted, too big, …)
      // so the user knows whether to paste instead or re-export the PDF.
      setPdfErr((e as Error).message || 'failed to read file');
    }
  }, [setCv]);

  // On mobile we collapse the "you already have a config" callout by default
  // so the CV upload stays above the fold (the callout's full prose pushes
  // the textarea + Choose-File button off-screen on a 390px viewport).
  const { isMobile } = useViewport();
  const [calloutOpen, setCalloutOpen] = useState(!isMobile);
  return (
    <div>
      {haveExistingConfig && (
        <>
          {/* Mobile: collapsed by default — one-line summary + a "?" toggle.
              Desktop: full callout body inline (the original Banner). */}
          <div className="mb-4 md:hidden">
            <button
              type="button"
              onClick={() => { setCalloutOpen((v) => !v); }}
              aria-expanded={calloutOpen}
              className="flex w-full items-center justify-between rounded border border-indigo-200 bg-indigo-50 px-3 py-2 text-left text-sm text-indigo-800"
            >
              <span>You already have a config — saved as a new profile by default.</span>
              <span className="ml-2 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-indigo-300 text-xs font-semibold">
                {calloutOpen ? '−' : '?'}
              </span>
            </button>
            {calloutOpen && (
              <div className="mt-1 rounded border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs text-indigo-800">
                At the end of setup you can either save the generated config
                as a <span className="font-semibold">new profile</span>{' '}
                (recommended — keeps your current one untouched) or{' '}
                <span className="font-semibold">overwrite the active profile</span>.
              </div>
            )}
          </div>
          <div className="hidden md:block">
            <Banner kind="info">
              You already have a config. At the end of setup you can either save
              the generated one as a <span className="font-semibold">new profile</span>{' '}
              (recommended — keeps your current one untouched) or{' '}
              <span className="font-semibold">overwrite the active profile</span>.
            </Banner>
          </div>
        </>
      )}
      <h2 className="mb-2 text-base font-semibold text-slate-800">Your CV</h2>
      <p className="mb-3 text-sm text-slate-600">
        Upload a plain-text or PDF file, or paste below. The scraper will score
        jobs against this CV on every run.
      </p>
      <div className="mb-3 flex items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.md,.pdf,text/plain"
          className="block text-sm text-slate-600 file:mr-3 file:rounded file:border-0 file:bg-indigo-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-indigo-700 hover:file:bg-indigo-100"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) await onFile(f);
          }}
        />
        {cv && (
          <button
            type="button"
            onClick={() => {
              setCv('');
              setPdfErr(null);
              if (fileRef.current) fileRef.current.value = '';
            }}
            className="text-xs text-slate-500 hover:text-rose-600"
          >
            Clear
          </button>
        )}
      </div>
      {pdfErr && (
        <Banner kind="warn">
          {pdfErr} — paste the plain text below instead.
        </Banner>
      )}
      <textarea
        value={cv}
        onChange={(e) => { setCv(e.target.value); }}
        placeholder="Paste your CV here…"
        className="h-72 w-full rounded border border-slate-300 bg-white p-3 text-sm font-mono leading-5 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-slate-500">
          {cv.length.toLocaleString()} chars
          {cv.length < CV_MIN_CHARS && ` (need ≥ ${CV_MIN_CHARS})`}
        </span>
        <div className="flex gap-2">
          <BackButton onBack={onBack} />
          <button
            type="button"
            onClick={onNext}
            disabled={cv.length < CV_MIN_CHARS}
            className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
};
