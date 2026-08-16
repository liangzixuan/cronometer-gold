import { assertDatabaseReady, createDatabaseFromEnvironment } from "@nutrition-tracker/db";
import {
  FoodSearchService as CoreFoodSearchService,
  MeilisearchFoodSearchBackend,
  MeilisearchHttpClient,
} from "@nutrition-tracker/search";

import type { ApiDependencyConfig } from "./config.js";
import { type AuthService, SecureAuthService } from "./modules/auth/auth-service.js";
import type { DiaryService } from "./modules/diary/diary.routes.js";
import { DatabaseBackedFoodSearchService } from "./modules/foods/search-service.js";
import type { ProfileService } from "./modules/profile/profile.routes.js";
import {
  DatabaseAuthRepository,
  DatabaseDiaryService,
  DatabaseProfileService,
} from "./persistence-services.js";

export interface ApiSearchRuntime {
  readonly authService: AuthService;
  readonly diaryService: DiaryService;
  readonly foodSearchService: DatabaseBackedFoodSearchService;
  readonly profileService: ProfileService;
  readonly readinessCheck: () => Promise<boolean>;
  close(): Promise<void>;
}

export function createApiSearchRuntime(
  environment: NodeJS.ProcessEnv,
  config: ApiDependencyConfig,
): ApiSearchRuntime {
  // Validate all pure search configuration before allocating the database pool.
  const client = new MeilisearchHttpClient({
    host: config.meiliUrl,
    requestTimeoutMs: config.searchRequestTimeoutMs,
    ...(config.meiliSearchKey === undefined ? {} : { apiKey: config.meiliSearchKey }),
  });
  const core = new CoreFoodSearchService({
    backend: new MeilisearchFoodSearchBackend({ client }),
    cursorSecret: config.cursorSecret,
  });
  const database = createDatabaseFromEnvironment({
    ...environment,
    DATABASE_URL: config.databaseUrl,
  });
  const authService = new SecureAuthService({
    repository: new DatabaseAuthRepository(database),
  });

  return {
    authService,
    diaryService: new DatabaseDiaryService(database),
    foodSearchService: new DatabaseBackedFoodSearchService({
      core,
      database,
      maxConcurrentDatabaseOperations: config.searchDatabaseMaxConcurrency,
      maxQueuedDatabaseOperations: config.searchDatabaseMaxQueue,
    }),
    profileService: new DatabaseProfileService(database),
    async readinessCheck() {
      await assertDatabaseReady(database);
      return true;
    },
    async close() {
      await database.destroy();
    },
  };
}
