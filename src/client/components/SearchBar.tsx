import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, Headphones, Search, X } from "lucide-react";
import { apiGet } from "../lib/api";
import type { BookSummary, BooksPageResponse } from "../../shared/types";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  /** Called when the user presses Enter (with no dropdown item highlighted). */
  onSubmit?: (value: string) => void;
  placeholder?: string;
}

export function SearchBar({ value, onChange, onSubmit, placeholder = "Search books & audiobooks…" }: SearchBarProps) {
  const navigate = useNavigate();
  const [results, setResults] = useState<BookSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch dropdown results whenever value changes
  useEffect(() => {
    const trimmed = value.trim();
    if (trimmed.length < 1) {
      setResults([]);
      setOpen(false);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const data = await apiGet<BooksPageResponse>(
          `/api/books?q=${encodeURIComponent(trimmed)}&pageSize=8&sortBy=title-asc&mediaType=all`
        );
        setResults(data.items);
        setOpen(data.items.length > 0);
        setActiveIndex(-1);
      } catch {
        setResults([]);
        setOpen(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [value]);

  // Close on outside click
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      if (activeIndex >= 0 && results[activeIndex]) {
        // Navigate directly to the highlighted book
        const highlighted = results[activeIndex]!;
        const section = highlighted.mediaType === "audiobook" ? "audiobooks" : "books";
        void navigate(`/${section}/${highlighted.id}`);
        setOpen(false);
      } else {
        setOpen(false);
        onSubmit?.(value);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  function handleResultClick(book: BookSummary) {
    setOpen(false);
    const section = book.mediaType === "audiobook" ? "audiobooks" : "books";
    void navigate(`/${section}/${book.id}`);
  }

  return (
    <div ref={containerRef} className="relative">
      <Search
        size={16}
        className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none z-10"
      />
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => { onChange(e.target.value); setActiveIndex(-1); }}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
        onKeyDown={handleKeyDown}
        className="w-full bg-background-container-low border border-outline-variant/30 rounded-lg pl-9 pr-8 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-outline-variant/60"
        autoComplete="off"
      />
      {value && (
        <button
          onMouseDown={(e) => {
            // Prevent the input from losing focus before the click registers
            e.preventDefault();
            onChange("");
            setResults([]);
            setOpen(false);
          }}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface transition-colors z-10"
          aria-label="Clear search"
        >
          <X size={14} />
        </button>
      )}

      {open && results.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1.5 bg-background-container border border-outline-variant/20 rounded-xl shadow-2xl overflow-hidden z-50">
          {results.map((book, index) => (
            <button
              key={book.id}
              onMouseDown={() => handleResultClick(book)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                index === activeIndex
                  ? "bg-background-container-highest"
                  : "hover:bg-background-container-high"
              }`}
            >
              {/* Tiny cover */}
              <div className={`flex-shrink-0 rounded overflow-hidden bg-background-container-highest ${book.mediaType === "audiobook" ? "w-8 h-8" : "w-8 h-12"}`}>
                {book.coverUrl ? (
                  <img src={book.coverUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <BookOpen size={12} className="text-on-surface-variant" />
                  </div>
                )}
              </div>
              {/* Media type icon */}
              <div className="flex-shrink-0 text-on-surface-variant/60" title={book.mediaType === "audiobook" ? "Audiobook" : "Book"}>
                {book.mediaType === "audiobook"
                  ? <Headphones size={13} strokeWidth={1.75} />
                  : <BookOpen size={13} strokeWidth={1.75} />
                }
              </div>
              {/* Title + author */}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-on-surface truncate">{book.title}</div>
                {book.author && (
                  <div className="text-xs text-on-surface-variant truncate">{book.author}</div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
