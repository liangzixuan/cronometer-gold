import { describe, expect, it } from "vitest";
import {
  adaptCnfTables,
  adaptFdcJsonRelease,
  canonicalJson,
  parseDelimitedObjects,
  proposeCanonicalNutrientMapping,
  stageCnfRecordDetailed,
  stageFdcCsvRecord,
  stageFdcJsonRecord,
  stageFdcJsonRecordDetailed,
} from "../src/index.js";

describe("streaming delimited parser", () => {
  it("handles a UTF-8 BOM, quoted newlines, escaped quotes, and chunk boundaries", async () => {
    const encoded = new TextEncoder().encode(
      '\uFEFFFood_Code,Food_Description_EN\r\n1,"Apple, raw"\r\n2,"A ""quoted""\nfood"',
    );
    const chunks = [encoded.slice(0, 7), encoded.slice(7, 31), encoded.slice(31)];
    const records = [];
    for await (const row of parseDelimitedObjects(chunks)) {
      records.push(row);
    }
    expect(records).toEqual([
      { line: 2, record: { Food_Code: "1", Food_Description_EN: "Apple, raw" } },
      { line: 3, record: { Food_Code: "2", Food_Description_EN: 'A "quoted"\nfood' } },
    ]);
  });

  it("rejects duplicate headers and malformed rows", async () => {
    await expect(async () => {
      for await (const _row of parseDelimitedObjects(["id,id\n1,2"])) {
        // consume
      }
    }).rejects.toMatchObject({ code: "DUPLICATE_KEY" });
    await expect(async () => {
      for await (const _row of parseDelimitedObjects(['id,name\n1,"unterminated'])) {
        // consume
      }
    }).rejects.toMatchObject({ code: "INVALID_RECORD" });
  });
});

describe("USDA FoodData Central adapters", () => {
  const food = {
    fdcId: 123,
    dataType: "Foundation",
    description: "Apple, raw",
    publicationDate: "4/1/2019",
    foodNutrients: [
      {
        amount: 0,
        dataPoints: 7,
        foodNutrientDerivation: { code: "A" },
        nutrient: { id: 1003, name: "Protein", unitName: "G" },
      },
      {
        amount: null,
        nutrient: { id: 2066, name: "Vitamin A", unitName: "UG" },
      },
      {
        amount: -0.06,
        nutrient: { id: 1005, name: "Carbohydrate, by difference", unitName: "G" },
      },
    ],
    foodPortions: [
      { id: 9, amount: 1, gramWeight: 182, modifier: "", measureUnit: { name: "apple" } },
      { id: 10, amount: 1, gramWeight: 0, modifier: "bad", measureUnit: { name: "unit" } },
    ],
  };

  it("preserves known zero and missing values while excluding only invalid child facts", () => {
    const result = adaptFdcJsonRelease(
      { FoundationFoods: [food, null] },
      { releaseKey: "fdc-2026-04" },
    );
    expect(result.records).toHaveLength(1);
    expect(result.quarantined).toHaveLength(1);
    expect(result.excludedNutrients).toHaveLength(1);
    expect(result.excludedNutrients[0]?.message).toContain("negative");
    expect(result.excludedPortions).toHaveLength(1);
    expect(result.records[0]?.nutrients).toEqual([
      expect.objectContaining({
        sourceNutrientId: "1003",
        canonicalNutrientId: null,
        provenance: { derivationCode: "A", dataPoints: 7 },
        value: { state: "known", amount: "0", quality: "measured" },
      }),
      expect.objectContaining({
        sourceNutrientId: "2066",
        value: { state: "unknown", reason: "not_reported" },
      }),
    ]);
    expect(result.records[0]?.servings).toHaveLength(1);
    expect(result.records[0]?.servings[0]?.description).toBe("apple");
    expect(result.records[0]?.source).toMatchObject({
      languageTag: "en",
      marketCode: "US",
      sourceModifiedAt: "2019-04-01",
    });
  });

  it("does not require portions and makes reviewed canonical mapping an injected decision", () => {
    const withoutPortions = { ...food, foodPortions: [], foodNutrients: [food.foodNutrients[0]] };
    const unmapped = stageFdcJsonRecord(withoutPortions, { releaseKey: "r1" });
    const mapped = stageFdcJsonRecord(withoutPortions, {
      releaseKey: "r1",
      mappingResolver: (request) =>
        request.sourceNutrientId === "1003" ? { nutrientId: "protein", unit: "g" } : null,
    });
    expect(unmapped.servings).toEqual([]);
    expect(unmapped.nutrients[0]?.canonicalNutrientId).toBeNull();
    expect(mapped.nutrients[0]?.canonicalNutrientId).toBe("protein");
  });

  it("excludes an invalid GTIN attribute without losing the food", () => {
    const result = stageFdcJsonRecordDetailed(
      { ...food, gtinUpc: "123456789", foodNutrients: [], foodPortions: [] },
      { releaseKey: "r1" },
    );
    expect(result.record.identity.gtin).toBeNull();
    expect(result.excludedAttributes).toEqual([
      expect.objectContaining({ attribute: "gtin", code: "INVALID_RECORD" }),
    ]);
  });

  it("quarantines duplicate top-level food keys and returns deterministic records", () => {
    const first = adaptFdcJsonRelease(
      { FoundationFoods: [food, structuredClone(food)] },
      { releaseKey: "r1" },
    );
    const second = adaptFdcJsonRelease({ FoundationFoods: [food] }, { releaseKey: "r1" });
    expect(first.records).toHaveLength(1);
    expect(first.quarantined[0]?.code).toBe("DUPLICATE_KEY");
    expect(canonicalJson(first.records[0])).toBe(canonicalJson(second.records[0]));
  });

  it("adapts joined FDC CSV fixture rows", () => {
    const record = stageFdcCsvRecord(
      {
        fdc_id: "77",
        data_type: "Foundation",
        description: "Pear",
        publication_date: "2026-04-30",
      },
      [
        {
          fdc_id: "77",
          nutrient_id: "1008",
          nutrient_name: "Energy",
          unit_name: "KCAL",
          amount: "57.0",
          derivation_id: "49",
          data_points: "3",
        },
      ],
      [],
      { releaseKey: "r1" },
    );
    expect(record.nutrients[0]).toMatchObject({
      sourceNutrientId: "1008",
      originalUnit: "KCAL",
      value: { state: "known", amount: "57", quality: "measured" },
      provenance: { derivationCode: "49", dataPoints: 3 },
    });
  });
});

describe("Health Canada CNF 2026 adapter", () => {
  const tables = {
    foodNames: [
      {
        Food_Code: "101",
        Food_Description_EN: "Milk, whole",
        Food_Description_FR: "Lait entier",
        Food_Last_Updated_Date: "2026-01-15",
      },
    ],
    nutrientNames: [
      {
        Nutrient_Code: "208",
        Nutrient_Symbol: "KCAL",
        Nutrient_Unit: "kcal",
        Nutrient_Name_EN: "Energy",
        Tagname: "ENERC_KCAL",
      },
      {
        Nutrient_Code: "269",
        Nutrient_Symbol: "TSUG",
        Nutrient_Unit: "g",
        Nutrient_Name_EN: "Total sugars",
        Tagname: "SUGAR",
      },
    ],
    nutrientAmounts: [
      {
        Food_Code: "101",
        Nutrient_Code: "208",
        Nutrient_Amount: "61",
        Nutrient_Source_ID: "1",
        Observations: "4.0",
      },
      { Food_Code: "101", Nutrient_Code: "269", Nutrient_Amount: "Tr" },
    ],
    measureNames: [
      { Measure_Code: "100", Measure_Description_and_Unit_EN: "1 cup (250 mL)" },
      { Measure_Code: "750", Measure_Description_and_Unit_EN: "total refuse" },
    ],
    measureWeightConversions: [
      {
        Food_Code: "101",
        Measure_Type_Code: "6",
        Measure_Code: "100",
        Measure_Weight_Conversion: "258",
      },
      {
        Food_Code: "101",
        Measure_Type_Code: "3",
        Measure_Code: "750",
        Measure_Weight_Conversion: "0",
      },
    ],
  } as const;

  it("uses official headers and keeps refuse/yield rows out of user-facing servings", () => {
    const result = adaptCnfTables(tables, { releaseKey: "cnf-2026" });
    expect(result.quarantined).toEqual([]);
    expect(result.records[0]?.identity).toMatchObject({
      description: "Milk, whole",
      descriptionFr: "Lait entier",
    });
    expect(result.records[0]?.source).toMatchObject({
      languageTag: "en",
      marketCode: "CA",
      sourceModifiedAt: "2026-01-15",
    });
    expect(result.records[0]?.servings).toEqual([
      expect.objectContaining({ description: "1 cup (250 mL)", gramWeight: "258" }),
    ]);
    expect(result.skippedMeasures).toEqual([
      expect.objectContaining({
        sourceIndex: 1,
        reason: "non_user_facing_refuse",
        measureCode: "750",
      }),
    ]);
    expect(result.records[0]?.nutrients[0]).toMatchObject({
      sourceName: "Energy",
      canonicalNutrientId: null,
      provenance: { derivationCode: "1", dataPoints: 4 },
    });
    expect(result.records[0]?.nutrients[1]?.value).toEqual({
      state: "trace",
      detectionLimit: null,
    });
    expect(result.conservation).toEqual({
      foodNames: { sourceCount: 1, emittedCount: 1, quarantinedCount: 0 },
      nutrientAmounts: { sourceCount: 2, emittedCount: 2, excludedCount: 0 },
      measureWeightConversions: {
        sourceCount: 2,
        emittedCount: 1,
        excludedCount: 0,
        skippedCount: 1,
      },
    });
    expect(result.rowDispositions).toEqual({
      foodNames: [{ disposition: "emitted", sourceIndex: 0 }],
      measureWeightConversions: [
        { disposition: "emitted", sourceIndex: 0 },
        { disposition: "skipped", sourceIndex: 1 },
      ],
      nutrientAmounts: [
        { disposition: "emitted", sourceIndex: 0 },
        { disposition: "emitted", sourceIndex: 1 },
      ],
    });
  });

  it("preserves known zero separately from trace without applying mapping proposals", () => {
    const result = adaptCnfTables(
      {
        ...tables,
        nutrientAmounts: [
          { ...tables.nutrientAmounts[0], Nutrient_Amount: "0" },
          tables.nutrientAmounts[1],
        ],
        measureWeightConversions: [],
      },
      { releaseKey: "cnf-2026" },
    );
    expect(result.records[0]?.nutrients).toEqual([
      expect.objectContaining({
        sourceNutrientId: "208",
        canonicalNutrientId: null,
        value: { state: "known", amount: "0", quality: "measured" },
      }),
      expect.objectContaining({
        sourceNutrientId: "269",
        canonicalNutrientId: null,
        value: { state: "trace", detectionLimit: null },
      }),
    ]);
  });

  it("keeps malformed measure rows inside the child boundary with global source indexes", () => {
    const result = adaptCnfTables(
      {
        ...tables,
        nutrientAmounts: [],
        measureWeightConversions: [
          tables.measureWeightConversions[0],
          {
            Food_Code: "101",
            Measure_Code: "100",
            Measure_Weight_Conversion: "258",
          },
          {
            Food_Code: "101",
            Measure_Type_Code: "6",
            Measure_Weight_Conversion: "258",
          },
          {
            Food_Code: "101",
            Measure_Type_Code: "9",
            Measure_Code: "750",
            Measure_Weight_Conversion: "0",
          },
        ],
      },
      { releaseKey: "cnf-2026" },
    );
    expect(result.records).toHaveLength(1);
    expect(result.quarantined).toEqual([]);
    expect(result.excludedMeasures).toEqual([
      expect.objectContaining({
        foodCode: "101",
        sourceIndex: 1,
        code: "INVALID_RECORD",
        sourcePayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        foodCode: "101",
        sourceIndex: 2,
        code: "INVALID_RECORD",
        sourcePayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(result.skippedMeasures).toEqual([
      expect.objectContaining({
        foodCode: "101",
        sourceIndex: 3,
        reason: "non_user_facing_yield",
        sourcePayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(result.conservation.measureWeightConversions).toEqual({
      sourceCount: 4,
      emittedCount: 1,
      excludedCount: 2,
      skippedCount: 1,
    });
    expect(result.rowDispositions.measureWeightConversions).toEqual([
      { disposition: "emitted", sourceIndex: 0 },
      { disposition: "excluded", sourceIndex: 1 },
      { disposition: "excluded", sourceIndex: 2 },
      { disposition: "skipped", sourceIndex: 3 },
    ]);
  });

  it("conserves children of a quarantined first parent exactly once across duplicates", () => {
    const result = adaptCnfTables(
      {
        ...tables,
        foodNames: [
          { Food_Code: "bad" },
          tables.foodNames[0],
          { Food_Code: "bad", Food_Description_EN: "Duplicate parent" },
        ],
        nutrientAmounts: [
          tables.nutrientAmounts[0],
          { ...tables.nutrientAmounts[1], Food_Code: "bad" },
          { ...tables.nutrientAmounts[0], Food_Code: "bad" },
        ],
        measureWeightConversions: [
          tables.measureWeightConversions[0],
          { ...tables.measureWeightConversions[1], Food_Code: "bad" },
          tables.measureWeightConversions[1],
        ],
      },
      { releaseKey: "cnf-2026" },
    );
    expect(result.records).toHaveLength(1);
    expect(result.quarantined).toEqual([
      expect.objectContaining({
        sourceIndex: 0,
        sourceRecordId: "bad",
        code: "INVALID_RECORD",
        sourcePayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        sourceIndex: 2,
        sourceRecordId: "bad",
        code: "DUPLICATE_KEY",
        sourcePayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(result.excludedNutrients).toEqual([
      expect.objectContaining({
        foodCode: "bad",
        sourceIndex: 1,
        code: "INVALID_RECORD",
        message: expect.stringContaining("parent Food_Code bad was quarantined"),
        sourcePayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        foodCode: "bad",
        sourceIndex: 2,
        code: "INVALID_RECORD",
        message: expect.stringContaining("parent Food_Code bad was quarantined"),
        sourcePayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(result.excludedMeasures).toEqual([
      expect.objectContaining({
        foodCode: "bad",
        sourceIndex: 1,
        code: "INVALID_RECORD",
        message: expect.stringContaining("parent Food_Code bad was quarantined"),
        sourcePayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(result.skippedMeasures).toEqual([
      expect.objectContaining({
        foodCode: "101",
        sourceIndex: 2,
        reason: "non_user_facing_refuse",
      }),
    ]);
    expect(result.conservation).toEqual({
      foodNames: { sourceCount: 3, emittedCount: 1, quarantinedCount: 2 },
      nutrientAmounts: { sourceCount: 3, emittedCount: 1, excludedCount: 2 },
      measureWeightConversions: {
        sourceCount: 3,
        emittedCount: 1,
        excludedCount: 1,
        skippedCount: 1,
      },
    });
    expect(result.rowDispositions).toEqual({
      foodNames: [
        { disposition: "quarantined", sourceIndex: 0 },
        { disposition: "emitted", sourceIndex: 1 },
        { disposition: "quarantined", sourceIndex: 2 },
      ],
      measureWeightConversions: [
        { disposition: "emitted", sourceIndex: 0 },
        { disposition: "excluded", sourceIndex: 1 },
        { disposition: "skipped", sourceIndex: 2 },
      ],
      nutrientAmounts: [
        { disposition: "emitted", sourceIndex: 0 },
        { disposition: "excluded", sourceIndex: 1 },
        { disposition: "excluded", sourceIndex: 2 },
      ],
    });
  });

  it("fails closed when a child row has no known parent key", () => {
    expect(() =>
      adaptCnfTables(
        {
          ...tables,
          nutrientAmounts: [{ ...tables.nutrientAmounts[0], Food_Code: "999" }],
          measureWeightConversions: [],
        },
        { releaseKey: "cnf-2026" },
      ),
    ).toThrowError(/references unknown CNF Food_Code: 999/);
    expect(() =>
      adaptCnfTables(
        {
          ...tables,
          nutrientAmounts: [],
          measureWeightConversions: [
            {
              Measure_Type_Code: "6",
              Measure_Code: "100",
              Measure_Weight_Conversion: "258",
            },
          ],
        },
        { releaseKey: "cnf-2026" },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RECORD" }));
  });

  it("offers symbol/tagname proposals without applying them by default", () => {
    expect(proposeCanonicalNutrientMapping("CNF", "208", "KCAL", "ENERC_KCAL")).toEqual({
      nutrientId: "energy",
      unit: "kcal",
    });
    expect(proposeCanonicalNutrientMapping("CNF", "269", "TSUG", "SUGAR")).toEqual({
      nutrientId: "sugars",
      unit: "g",
    });
  });

  it("rejects duplicate definition keys and duplicate nutrient facts", () => {
    expect(() =>
      adaptCnfTables(
        { ...tables, nutrientNames: [tables.nutrientNames[0], tables.nutrientNames[0]] },
        { releaseKey: "r1" },
      ),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_KEY" }));
    const detailed = stageCnfRecordDetailed(
      tables.foodNames[0],
      [tables.nutrientAmounts[0], tables.nutrientAmounts[0]],
      new Map(tables.nutrientNames.map((row) => [row.Nutrient_Code, row])),
      [],
      new Map(tables.measureNames.map((row) => [row.Measure_Code, row])),
      { releaseKey: "r1" },
    );
    expect(detailed.record.nutrients).toHaveLength(1);
    expect(detailed.excludedNutrients).toEqual([
      expect.objectContaining({ code: "DUPLICATE_KEY", foodCode: "101" }),
    ]);
  });
});
