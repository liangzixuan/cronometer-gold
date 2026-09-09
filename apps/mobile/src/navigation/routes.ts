export const authenticatedRoutes = {
  today: "Today",
  search: "Search",
  recipes: "Recipes",
  goals: "Goals",
  reports: "Reports",
  hydration: "Hydration",
  activity: "Activity",
  health: "Health",
  verifyEmail: "VerifyEmail",
} as const;

export const authenticatedRouteNames = [
  authenticatedRoutes.today,
  authenticatedRoutes.search,
  authenticatedRoutes.recipes,
  authenticatedRoutes.goals,
  authenticatedRoutes.reports,
  authenticatedRoutes.hydration,
  authenticatedRoutes.activity,
  authenticatedRoutes.health,
  authenticatedRoutes.verifyEmail,
] as const;

export type AuthenticatedRouteName = (typeof authenticatedRouteNames)[number];
