import { useState, type KeyboardEvent } from 'react';
import clsx from 'clsx';

// Chip-input: a freeform text field that turns Enter-keyed values into removable
// chips. Comma also commits, since several existing CSV-friendly fields use it.
// Backspace on an empty field removes the last chip — common UX, easy to undo.
export const ChipInput = ({
  values,
  onChange,
  placeholder,
  monospace = false,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  monospace?: boolean;
}) => {
  const [draft, setDraft] = useState('');

  const commit = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    if (values.includes(v)) {
      setDraft('');
      return;
    }
    onChange([...values, v]);
    setDraft('');
  };

  const remove = (i: number) => {
    onChange(values.filter((_, idx) => idx !== i));
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
      e.preventDefault();
      remove(values.length - 1);
    }
  };

  return (
    <div
      className={clsx(
        'flex flex-wrap gap-1.5 rounded border border-slate-300 bg-white px-2 py-1.5 focus-within:border-brand-700 focus-within:ring-1 focus-within:ring-brand-700',
        monospace && 'font-mono text-xs',
      )}
    >
      {values.map((v, i) => (
        <span
          key={`${i}-${v}`}
          className={clsx(
            'inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-800',
            monospace && 'font-mono',
          )}
        >
          {v}
          <button
            type="button"
            onClick={() => remove(i)}
            className="-mr-0.5 rounded-full px-1 text-brand-700 hover:bg-brand-100 hover:text-brand-900"
            title="Remove"
            aria-label={`Remove ${v}`}
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => commit(draft)}
        placeholder={values.length === 0 ? placeholder : ''}
        className={clsx(
          'min-w-[8rem] flex-1 border-0 bg-transparent p-0 text-sm focus:outline-none focus:ring-0',
          monospace && 'font-mono text-xs',
        )}
      />
    </div>
  );
};
