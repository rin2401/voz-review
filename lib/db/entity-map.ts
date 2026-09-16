import type { EntityMap } from "../entity-links";
import { getApartmentEntityMap } from "./apartment-queries";
import { getCompanyEntityMap } from "./queries";

/**
 * Merged apartment + company entity map for in-content entity linking.
 * Apartment names win on key collisions. Unlike wiki-style linking, the
 * current page's own entity stays linkable: comment threads read more
 * like discussions than encyclopedia articles.
 */
export async function getEntityMap(): Promise<EntityMap> {
  const [apartmentMap, companyMap] = await Promise.all([
    getApartmentEntityMap(),
    getCompanyEntityMap(),
  ]);
  return { ...companyMap, ...apartmentMap };
}
