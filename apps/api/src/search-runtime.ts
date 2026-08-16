import { assertDatabaseReady, createDatabaseFromEnvironment } from "@nutrition-tracker/db";
import {
  FoodSearchService as CoreFoodSearchService,
  MeilisearchFoodSearchBackend,
  MeilisearchHttpClient,
} from "@nutrition-tracker/search";

import type { ApiDependencyConfig } from "./config.js";
import { DatabaseBackedFoodSearchService } from "./modules/foods/search-service.js";

export interface ApiSearchRuntime {
  readonly foodSearchService: DatabaseBackedFoodSearchService;
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

  return {
    foodSearchService: new DatabaseBackedFoodSearchService({
      core,
      database,
      maxConcurrentDatabaseOperations: config.searchDatabaseMaxConcurrency,
      maxQueuedDatabaseOperations: config.searchDatabaseMaxQueue,
    }),
    async readinessCheck() {
      await assertDatabaseReady(database);
      return true;
    },
    async close() {
      await database.destroy();
    },
  };
}
