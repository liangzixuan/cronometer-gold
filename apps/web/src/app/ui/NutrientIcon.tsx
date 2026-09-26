import Image from "next/image";
import { Icon } from "./Icon";

const nutrientImages = {
  protein: "/images/nutrients/protein.png",
  carbohydrate: "/images/nutrients/carbohydrate.png",
  fat: "/images/nutrients/fat.png",
} as const;

export type NutrientIconName = "energy" | keyof typeof nutrientImages;

/** Decorative nutrient symbols; callers provide the visible nutrient name and value. */
export function NutrientIcon({ nutrient }: { readonly nutrient: NutrientIconName }) {
  return (
    <span aria-hidden="true" className="nutrientIcon" data-nutrient={nutrient}>
      {nutrient === "energy" ? (
        <Icon name="energy" />
      ) : (
        <Image src={nutrientImages[nutrient]} width={40} height={40} alt="" unoptimized />
      )}
    </span>
  );
}
