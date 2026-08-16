import { compareDeterministicText } from "./deterministic.js";
import { inferPreferredKind } from "./query.js";
import type {
  FoodSearchDocument,
  FoodSearchPreferences,
  NormalizedFoodSearchQuery,
} from "./types.js";

export const MAX_PERSONALIZATION_CANDIDATES = 250;

interface RankedCandidate {
  readonly backendRank: number;
  readonly document: FoodSearchDocument;
  readonly score: number;
}

function favoriteSet(preferences: FoodSearchPreferences | undefined): ReadonlySet<string> {
  return new Set(preferences?.favoriteFoodIds ?? []);
}

function recentRanks(preferences: FoodSearchPreferences | undefined): ReadonlyMap<string, number> {
  const newestByFood = new Map<string, number>();
  for (const recent of preferences?.recentFoods ?? []) {
    const timestamp = Date.parse(recent.lastUsedAt);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    const previous = newestByFood.get(recent.foodId);
    if (previous === undefined || timestamp > previous) {
      newestByFood.set(recent.foodId, timestamp);
    }
  }
  const ordered = [...newestByFood.entries()].sort(
    ([leftId, leftTime], [rightId, rightTime]) =>
      rightTime - leftTime || compareDeterministicText(leftId, rightId),
  );
  return new Map(ordered.map(([foodId], index) => [foodId, index]));
}

/**
 * Re-ranks only a bounded set already judged relevant by Meilisearch. Scores are integer and the
 * final identity comparison makes output stable even when backend scores and preferences tie.
 */
export function rerankFoodCandidates(
  documents: readonly FoodSearchDocument[],
  query: NormalizedFoodSearchQuery,
  preferences: FoodSearchPreferences | undefined,
): readonly FoodSearchDocument[] {
  const favorites = favoriteSet(preferences);
  const recents = recentRanks(preferences);
  const preferredKind = inferPreferredKind(query, documents);
  const seenFoodIds = new Set<string>();
  const ranked: RankedCandidate[] = [];

  for (const [backendRank, document] of documents.entries()) {
    if (seenFoodIds.has(document.foodId)) {
      continue;
    }
    seenFoodIds.add(document.foodId);
    const recentRank = recents.get(document.foodId);
    const favoriteBonus = favorites.has(document.foodId) ? 50 : 0;
    const recentBonus = recentRank === undefined ? 0 : Math.max(30 - recentRank, 1);
    const kindTieBreak = document.kind === preferredKind ? 2 : 0;
    ranked.push({
      backendRank,
      document,
      score: -backendRank + favoriteBonus + recentBonus + kindTieBreak,
    });
  }

  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      left.backendRank - right.backendRank ||
      compareDeterministicText(left.document.foodId, right.document.foodId) ||
      compareDeterministicText(left.document.foodVersionId, right.document.foodVersionId),
  );
  return ranked.map(({ document }) => document);
}
