import { getApartmentEntityMap } from "./apartment-queries";
import { getCompanyEntityMap } from "./queries";

/**
 * Merged apartment + company entity map for in-content entity linking.
 * Apartment names win on key collisions. `exclude` drops the current
 * page's own entity — Wikipedia-style: never link a page to itself.
 */
export async function getEntityMap(
  exclude: { apartmentSlug?: string; companySlug?: string } = {},
): Promise<Record<string, string>> {
  const [apartmentMap, companyMap] = await Promise.all([
    getApartmentEntityMap(),
    getCompanyEntityMap(),
  ]);
  const entityMap: Record<string, string> = { ...companyMap, ...apartmentMap };
  for (const key of Object.keys(entityMap)) {
    const href = entityMap[key];
    if (
      (exclude.apartmentSlug && href === `/apartments/${exclude.apartmentSlug}`) ||
      (exclude.companySlug && href === `/company/${exclude.companySlug}`)
    ) {
      delete entityMap[key];
    }
  }
  return entityMap;
}
