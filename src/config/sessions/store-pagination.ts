/**
 * Session store pagination utilities.
 *
 * Ported from claude-code HISTORY_PAGE_SIZE + before_id cursor pattern.
 * Allows callers to load a bounded page of session entries sorted by
 * recency (updatedAt descending) without holding all entries in memory.
 *
 * Why this matters: session stores can grow to thousands of entries.
 * Iterating over all entries to build a list response wastes memory and
 * forces the LLM to process irrelevant session context. Cursor-based
 * paging surfaces only the relevant window.
 */

import type { SessionEntry } from "./types.js";

/** Default page size, matching claude-code's HISTORY_PAGE_SIZE = 100. */
export const SESSION_HISTORY_PAGE_SIZE = 100;

export type SessionPageEntry = {
  key: string;
  entry: SessionEntry;
};

export type SessionPageResult = {
  /** Entries for this page, most-recent first. */
  entries: SessionPageEntry[];
  /** Pass as `beforeId` in the next call to get the following page. Undefined when no more pages. */
  nextCursor: string | undefined;
  /** Total number of entries in the store (before filtering). */
  totalCount: number;
};

/**
 * Load a page of session entries from the store, sorted by `updatedAt` descending.
 *
 * @param store     - The full session store record.
 * @param pageSize  - Maximum entries per page (default: SESSION_HISTORY_PAGE_SIZE).
 * @param beforeId  - Cursor: skip all entries with `updatedAt` >=  the entry whose key is `beforeId`.
 *                    Enables stable forward-paging even while new sessions are added.
 */
export function loadSessionPage(
  store: Record<string, SessionEntry>,
  options: {
    pageSize?: number;
    beforeId?: string;
  } = {},
): SessionPageResult {
  const pageSize = Math.max(1, options.pageSize ?? SESSION_HISTORY_PAGE_SIZE);
  const totalCount = Object.keys(store).length;

  // Sort all entries newest-first by updatedAt.
  const sorted: SessionPageEntry[] = Object.entries(store)
    .map(([key, entry]) => ({ key, entry }))
    .sort((a, b) => {
      const ta = a.entry.updatedAt ?? 0;
      const tb = b.entry.updatedAt ?? 0;
      if (tb !== ta) {
        return tb - ta;
      }
      // Stable secondary sort: lexicographic key order.
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

  // Apply before_id cursor: find the pivot entry and skip everything at or before it.
  let startIndex = 0;
  if (options.beforeId) {
    const pivotIndex = sorted.findIndex((e) => e.key === options.beforeId);
    if (pivotIndex >= 0) {
      startIndex = pivotIndex + 1;
    }
  }

  const page = sorted.slice(startIndex, startIndex + pageSize);
  const nextStartIndex = startIndex + pageSize;
  const nextCursor =
    nextStartIndex < sorted.length ? sorted[nextStartIndex - 1]?.key : undefined;

  return {
    entries: page,
    nextCursor,
    totalCount,
  };
}
