import { ChipInput } from './ChipInput';
import { newCategoryId } from './configMigrate';
import type { Category, CategoryType } from './configTypes';

const CategoryRow = ({
  category,
  isFirst,
  isLast,
  onChange,
  onMove,
  onDelete,
}: {
  category: Category;
  isFirst: boolean;
  isLast: boolean;
  onChange: (next: Category) => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}) => {
  const setName = (name: string) => { onChange({ ...category, name }); };
  const setType = (type: CategoryType) => { onChange({ ...category, type }); };
  const setQueries = (queries: string[]) => { onChange({ ...category, queries }); };

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 flex items-center gap-2">
        {/* Up/down buttons — drag-and-drop would be overkill for ~5 cats. */}
        <div className="flex flex-col gap-0.5">
          <button
            type="button"
            onClick={() => { onMove(-1); }}
            disabled={isFirst}
            className="rounded border border-slate-300 bg-white px-1.5 text-[10px] text-slate-500 hover:border-brand-500 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
            title="Move up"
            aria-label="Move category up"
          >
            ▲
          </button>
          <button
            type="button"
            onClick={() => { onMove(1); }}
            disabled={isLast}
            className="rounded border border-slate-300 bg-white px-1.5 text-[10px] text-slate-500 hover:border-brand-500 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
            title="Move down"
            aria-label="Move category down"
          >
            ▼
          </button>
        </div>

        <input
          type="text"
          value={category.name}
          onChange={(e) => { setName(e.target.value); }}
          placeholder="Category name (e.g. ML Researcher)"
          className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm font-medium focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700"
        />

        <button
          type="button"
          onClick={onDelete}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-500 hover:border-red-300 hover:text-red-600"
          title="Delete category"
        >
          Delete
        </button>
      </div>

      <div className="mb-2 flex flex-wrap items-start gap-3 px-1">
        <label className="inline-flex items-center gap-1.5 text-xs text-slate-700">
          <input
            type="radio"
            name={`type-${category.id}`}
            checked={category.type === 'keyword'}
            onChange={() => { setType('keyword'); }}
            className="text-brand-700 focus:ring-brand-700"
          />
          Keyword search
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-slate-700">
          <input
            type="radio"
            name={`type-${category.id}`}
            checked={category.type === 'company'}
            onChange={() => { setType('company'); }}
            className="text-brand-700 focus:ring-brand-700"
          />
          Company search
        </label>
      </div>

      <div className="px-1">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs font-semibold text-slate-700">
            Queries
          </label>
          <span className="text-[11px] tabular-nums text-slate-400">
            {category.queries.length}
          </span>
        </div>
        <ChipInput
          values={category.queries}
          onChange={setQueries}
          placeholder={
            category.type === 'company'
              ? "e.g. 'Fireblocks', 'Anthropic'"
              : "e.g. 'security researcher', 'data engineer'"
          }
        />
        <p className="mt-1 text-[11px] text-slate-500">
          Type a value and press Enter (or comma) to add. Backspace removes the last chip.
        </p>
      </div>
    </div>
  );
};

export const CategoryManager = ({
  categories,
  onChange,
}: {
  categories: Category[];
  onChange: (next: Category[]) => void;
}) => {
  const updateAt = (i: number, next: Category) => {
    const arr = [...categories];
    arr[i] = next;
    onChange(arr);
  };
  const removeAt = (i: number) => {
    onChange(categories.filter((_, idx) => idx !== i));
  };
  const moveAt = (i: number, delta: -1 | 1) => {
    const j = i + delta;
    if (j < 0 || j >= categories.length) return;
    const arr = [...categories];
    const ai = arr[i];
    const aj = arr[j];
    if (ai === undefined || aj === undefined) return;
    arr[i] = aj;
    arr[j] = ai;
    onChange(arr);
  };
  const add = () => {
    onChange([
      ...categories,
      {
        id: newCategoryId(),
        name: 'New category',
        type: 'keyword',
        queries: [],
      },
    ]);
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600">
          Search categories
        </h2>
        <button
          type="button"
          onClick={add}
          className="rounded border border-dashed border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:border-brand-500 hover:text-brand-700"
        >
          + Add category
        </button>
      </div>
      <p className="mb-3 text-xs text-slate-500">
        Each category is a list of LinkedIn search queries. <span className="font-medium">Keyword</span> runs the term
        through normal search and filters by title relevance; <span className="font-medium">Company</span> runs it as a
        company-name search and only keeps matching companies.
      </p>

      {categories.length === 0 ? (
        <p className="rounded border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
          No categories yet. Click <span className="font-semibold">+ Add category</span> to create one.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {categories.map((cat, i) => (
            <CategoryRow
              key={cat.id}
              category={cat}
              isFirst={i === 0}
              isLast={i === categories.length - 1}
              onChange={(next) => { updateAt(i, next); }}
              onMove={(delta) => { moveAt(i, delta); }}
              onDelete={() => { removeAt(i); }}
            />
          ))}
        </div>
      )}
    </section>
  );
};
