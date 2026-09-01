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
import type { GoalService } from "./modules/goals/goal.routes.js";
import type { ProfileService } from "./modules/profile/profile.routes.js";
import type { RecipeService } from "./modules/recipes/recipe.routes.js";
import type { RetentionService } from "./modules/retention/retention.routes.js";
import {
  DatabaseAuthRepository,
  DatabaseDiaryService,
  DatabaseGoalService,
  DatabaseProfileService,
  DatabaseRecipeService,
} from "./persistence-services.js";
import { createApiRetentionArtifactRuntime } from "./retention-artifact-runtime.js";
import { DatabaseRetentionService } from "./retention-persistence-service.js";

export interface ApiSearchRuntime {
  readonly authService: AuthService;
  readonly diaryService: DiaryService;
  readonly foodSearchService: DatabaseBackedFoodSearchService;
  readonly goalService: GoalService;
  readonly profileService: ProfileService;
  readonly recipeService: RecipeService;
  readonly retentionService?: RetentionService;
  readonly readinessCheck: () => Promise<boolean>;
  close(): Promise<void>;
}

export interface ApiSearchRuntimeOptions {
  readonly clock?: () => Date;
}

export async function createApiSearchRuntime(
  environment: NodeJS.ProcessEnv,
  config: ApiDependencyConfig,
  options: ApiSearchRuntimeOptions = {},
): Promise<ApiSearchRuntime> {
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
  const retentionArtifacts = config.retention
    ? await createApiRetentionArtifactRuntime(config.retention, {
        ...(options.clock ? { clock: options.clock } : {}),
      })
    : null;
  const database = createDatabaseFromEnvironment({
    ...environment,
    DATABASE_URL: config.databaseUrl,
  });
  let closePromise: Promise<void> | undefined;
  const close = () => {
    closePromise ??= database.destroy();
    return closePromise;
  };

  try {
    const authService = new SecureAuthService({
      repository: new DatabaseAuthRepository(database),
      ...(options.clock ? { clock: options.clock } : {}),
    });
    const retentionService =
      config.retention && retentionArtifacts
        ? new DatabaseRetentionService({
            artifacts: retentionArtifacts,
            database,
            deviceChallengeHmacKey: config.retention.deviceChallengeHmacKey,
            erasureLedgerLocatorKeyRing: config.retention.erasureLedgerLocatorKeyRing,
            erasureStatusCapabilityHmacKey: config.retention.erasureStatusCapabilityHmacKey,
            ...(options.clock ? { clock: options.clock } : {}),
          })
        : undefined;

    return {
      authService,
      diaryService: new DatabaseDiaryService(database, { cursorSecret: config.cursorSecret }),
      foodSearchService: new DatabaseBackedFoodSearchService({
        core,
        database,
        maxConcurrentDatabaseOperations: config.searchDatabaseMaxConcurrency,
        maxQueuedDatabaseOperations: config.searchDatabaseMaxQueue,
      }),
      goalService: new DatabaseGoalService(database),
      profileService: new DatabaseProfileService(database),
      recipeService: new DatabaseRecipeService(database),
      ...(retentionService ? { retentionService } : {}),
      async readinessCheck() {
        if (config.requireDatabaseRestoreAttestation) {
          if (!config.databaseRestoreEpoch) {
            throw new Error("Database restore epoch was not configured");
          }
          await assertDatabaseReady(database, {
            requireRestoreAttestation: true,
            restoreEpoch: config.databaseRestoreEpoch,
          });
        } else {
          await assertDatabaseReady(database, {
            requireRestoreAttestation: false,
            ...(config.databaseRestoreEpoch ? { restoreEpoch: config.databaseRestoreEpoch } : {}),
          });
        }
        return true;
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "API dependency construction and database cleanup failed",
      );
    }
    throw error;
  }
}
