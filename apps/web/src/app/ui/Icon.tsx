const glyphs = {
  sun: "\uf185",
  moon: "\uf186",
  info: "\uf05a",
  energy: "\uf06d",
  dashboard: "\uf015",
  diary: "\uf073",
  foods: "\uf5d1",
  recipes: "\uf2e7",
  reports: "\uf080",
  goals: "\uf140",
  water: "\uf043",
  activity: "\uf554",
  privacy: "\uf3ed",
  leaf: "\uf06c",
  "chevron-left": "\uf053",
  "chevron-right": "\uf054",
  "chevron-down": "\uf078",
  plus: "\uf067",
  edit: "\uf304",
  more: "\uf141",
  note: "\uf249",
  search: "\uf002",
  settings: "\uf013",
} as const;

/** Decorative glyphs from the locally bundled Font Awesome Free font. */
export function Icon({ name }: { readonly name: keyof typeof glyphs }) {
  return (
    <span aria-hidden="true" className="appIcon">
      {glyphs[name]}
    </span>
  );
}
