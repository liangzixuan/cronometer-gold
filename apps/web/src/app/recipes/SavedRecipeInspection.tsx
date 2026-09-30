import { nutrientDisplay } from "../../lib/diary";
import type { RecipeView } from "../../lib/recipes-goals";

export type NutritionBasis = "per100Grams" | "perServing";

interface SavedRecipeInspectionProps {
  readonly recipe: RecipeView;
  readonly nutritionBasis: NutritionBasis;
  readonly controlsDisabled: boolean;
  readonly sourceLines: readonly string[];
  readonly onSelectNutritionBasis: (basis: NutritionBasis) => void;
}

export function SavedRecipeInspection({
  recipe,
  nutritionBasis,
  controlsDisabled,
  sourceLines,
  onSelectNutritionBasis,
}: SavedRecipeInspectionProps) {
  return (
    <>
      <section className="workspaceSection" aria-labelledby="warnings-heading">
        <h3 id="warnings-heading">Calculation assumptions & warnings</h3>
        <ul className="warningList">
          <li>
            <strong>{recipe.retentionPolicy.code.replaceAll("-", " ")}</strong>
            <br />
            {recipe.retentionPolicy.assumption}
          </li>
          {recipe.warnings.map((warning) => (
            <li key={warning.code}>
              <strong>{warning.code.replaceAll("_", " ")}</strong>
              <br />
              {warning.message}
            </li>
          ))}
        </ul>
        <p className="coverageCopy">
          Retention factors default to one unless a warning identifies a named, reviewed factor set.
          This is not a claim that cooking retained every nutrient.
        </p>
      </section>
      <section className="workspaceSection" aria-labelledby="nutrition-heading">
        <h3 id="nutrition-heading">Saved recipe nutrition</h3>
        <p className="coverageCopy">
          {recipe.name} · Saved version {recipe.versionNumber}. Unsaved recipe edits and the diary
          logging amount do not change these values.
        </p>
        <fieldset disabled={controlsDisabled}>
          <legend>Nutrition basis</legend>
          <button
            aria-pressed={nutritionBasis === "per100Grams"}
            className={nutritionBasis === "per100Grams" ? "buttonPrimary" : "buttonQuiet"}
            onClick={() => onSelectNutritionBasis("per100Grams")}
            type="button"
          >
            Per 100 g
          </button>{" "}
          {recipe.nutrientsPerServing !== null ? (
            <button
              aria-pressed={nutritionBasis === "perServing"}
              className={nutritionBasis === "perServing" ? "buttonPrimary" : "buttonQuiet"}
              onClick={() => onSelectNutritionBasis("perServing")}
              type="button"
            >
              Per serving ({recipe.servingLabel ?? "serving"})
            </button>
          ) : null}
        </fieldset>
        <section className="reportTableScroller" aria-label="Recipe nutrition table">
          <table className="nutritionTable">
            <caption>
              {nutritionBasis === "perServing"
                ? `Per serving (${recipe.servingLabel ?? "serving"})`
                : "Per 100 g"}
            </caption>
            <thead>
              <tr>
                <th>Nutrient</th>
                <th>Coverage</th>
                <th>Known amount</th>
              </tr>
            </thead>
            <tbody>
              {(nutritionBasis === "perServing" && recipe.nutrientsPerServing !== null
                ? recipe.nutrientsPerServing
                : recipe.nutrientsPer100Grams
              ).map((nutrient) => {
                const display = nutrientDisplay(nutrient);
                return (
                  <tr key={nutrient.nutrientId}>
                    <td>{nutrient.name}</td>
                    <td>{display.qualification}</td>
                    <td>{display.amount}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </section>
      <section className="workspaceSection" aria-labelledby="source-heading">
        <h3 id="source-heading">Transitive source provenance</h3>
        {sourceLines.map((line) => (
          <p className="sourceLine" key={line}>
            {line}
          </p>
        ))}
      </section>
    </>
  );
}
