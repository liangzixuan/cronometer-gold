export const authenticatedRoutes = {
  today: "Today",
  search: "Search",
  recipes: "Recipes",
  goals: "Goals",
} as const;

export const authenticatedRouteNames = [
  authenticatedRoutes.today,
  authenticatedRoutes.search,
  authenticatedRoutes.recipes,
  authenticatedRoutes.goals,
] as const;

export type AuthenticatedRouteName = (typeof authenticatedRouteNames)[number];
