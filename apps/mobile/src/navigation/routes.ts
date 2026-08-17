export const authenticatedRoutes = {
  today: "Today",
  search: "Search",
  recipes: "Recipes",
  goals: "Goals",
  health: "Health",
} as const;

export const authenticatedRouteNames = [
  authenticatedRoutes.today,
  authenticatedRoutes.search,
  authenticatedRoutes.recipes,
  authenticatedRoutes.goals,
  authenticatedRoutes.health,
] as const;

export type AuthenticatedRouteName = (typeof authenticatedRouteNames)[number];
