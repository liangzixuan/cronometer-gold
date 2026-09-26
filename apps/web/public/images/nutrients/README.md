# Nutrient icons

Sliced egg, wheat and cooking-oil bottle icons generated with the built-in OpenAI ImageGen tool on September 25, 2026 for the approved Calm Daily design. These are decorative nutrient symbols. Callers keep the nutrient name, amount and unit visible; the icons do not imply logged foods, nutrient sources or dietary recommendations.

Energy uses the existing Font Awesome Free 5.12.0 fire glyph (U+F06D) through Icon.tsx. Its existing font license and attribution are in ../../fonts/. The bundled font matches the original Bootstrap Studio SB Admin export (SHA-256 787d76ad6deab67ccf8bac1b584260205e114f508fc5542b612e3f75d49a34e4). The whole-egg, motor-oil-can and wine-bottle glyphs were unsuitable for the approved sliced egg and cooking-oil symbols; no wheat glyph was present in that export.

Each generated PNG was trimmed to its transparent bounds, fitted inside 112 × 112 pixels and padded to 128 × 128 with alpha preserved. Encoding used the existing sharp 0.35.4 dependency, PNG compression level 9. The assets support a 36–40 CSS pixel display at more than 3× resolution. No new application dependency was added. Original PNGs remain in the local ImageGen output store.

## Exact prompts

Each generation call used this shared prompt followed by `Subject: ` and its subject:

Use case: logo-brand. Asset type: one small raster UI nutrient icon for the warm Nourishing nutrition dashboard, rendered at 36 to 40 CSS pixels. Create a single isolated flat editorial icon on a genuinely transparent background, alpha transparency, no drawn checkerboard. Square canvas. Center the object and let it fill about 85 percent of the canvas with tight even transparent margins. Crisp clean solid shapes, very simple silhouette, restrained two or three warm colors, no gradients, no shadows, no photographic texture, no background, no circular badge or enclosing tile. Style: simple friendly familiar food symbol with a slightly rounded shape, consistent with a restrained modern nutrition app. No text, letters, numbers, logos, watermarks or extra objects. Not a photo or meal illustration.

- `protein.png`: One hard-boiled egg half, sliced lengthwise, viewed straight at the cut surface. Off-white oval egg white with a clear round golden ochre yolk in the middle, a thin muted olive-brown outer edge. The yolk must read clearly even at 36 pixels. Slight oval shape, upright.
- `carbohydrate.png`: One upright golden ochre wheat ear with a single slender central stalk and four paired plump pointed wheat grains along the stem, plus one grain at the tip. Simple clean silhouette, compact and easily recognizable as wheat, not a tree or leafy plant.
- `fat.png`: One small upright amber cooking-oil bottle with a short narrow neck and small muted olive screw cap, rounded shoulders, slightly rounded rectangular body, golden oil inside and one small blank off-white label. The bottle is a compact everyday cooking-oil container, not a tall wine bottle, motor-oil can or water droplet.

## Asset verification

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| protein.png | 10952 | e0e05177812f67e400a1f45b97c74e81f0dbeced6ac6e7640aad7d5dda792689 |
| carbohydrate.png | 7153 | 6cdb39a207d0d052a62ab41b92235e1e2fabe226d247b909cf7e428e4d65cbad |
| fat.png | 9846 | 2d27a7814b54829bacf26233e50441715b0ea792a2d5c78cdf359e9034ae4da8 |

## Generated source identity

| Asset | Original PNG | Source SHA-256 |
| --- | --- | --- |
| protein.png | exec-a1359b44-9a76-4c45-8841-6b65cbe6bd4d.png | f3d8ff9a6827c58d7afd1ab5e410a35ea819d536284623c0b60c5943bbb7e9a4 |
| carbohydrate.png | exec-08468de9-9a09-4ab9-aac9-4d2ef55877fc.png | ecea8e87fffdb2990812d89221cc1a2a11cad324ddd812a247f34c9f8ba14f6a |
| fat.png | exec-83251616-83da-46d5-a62f-5767c40700b4.png | da57113ed226bc1ffc4db5103822eecde8733d18d44db8a70b864fdd225799b8 |
