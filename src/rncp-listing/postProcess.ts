import axios from "axios";
import { appConfig } from "../config/appConfig";
import { normalizeCenterName } from "../utils/center";
import { humanDelay, randomBetween } from "../utils/humanizer";
import { logger } from "../utils/logger";

type Nullable<T> = T | null | undefined;

export type ListingOrganization = {
  key: string;
  name: string;
  rncpCodes: Set<string>;
  cities: Set<string>;
  postalCodes: Set<string>;
  regions: Set<string>;
  countries: Set<string>;
  trainingCount: number;
  detailUrl?: string;
  email?: string;
  phone?: string;
  website?: string;
  address?: string;
  siren?: string;
  siret?: string;
};

type OpenDataRecord = {
  fields: {
    denomination?: string;
    siren?: string;
    siretetablissementdeclarant?: string;
    adressephysiqueorganismeformation_ville?: string;
    adressephysiqueorganismeformation_codepostal?: string;
  } & Record<string, unknown>;
};

type OpenDataResponse = {
  records?: OpenDataRecord[];
};

const API_URL = "https://dgefp.opendatasoft.com/api/records/1.0/search/";
const DATASET = "liste-publique-des-of-v2";
const MAX_RESULTS = Number(process.env.OPENDATA_ROWS ?? 10);
const MAX_RETRIES = Number(process.env.OPENDATA_RETRIES ?? 2);
const INVALID_KEYS = new Set(["nd"]);

const normalize = (value: Nullable<string>): string | undefined => {
  if (!value) return undefined;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : undefined;
};

const cleanTextArtifacts = (value: string): string => {
  return value
    .replace(/Accès Personne à Mobilité Réduite/gi, " ")
    .replace(/dsfr-formation-carte\.accessibility\.accessible/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const cleanSet = (values: Set<string>): Set<string> => {
  const cleaned = new Set<string>();
  for (const value of values) {
    const next = cleanTextArtifacts(value);
    if (next) cleaned.add(next);
  }
  return cleaned;
};

const isInvalidOrganization = (org: ListingOrganization): boolean => {
  const key = org.key.trim().toLowerCase();
  const name = org.name.trim().toLowerCase();
  if (!key || !name) return true;
  if (INVALID_KEYS.has(key)) return true;
  if (/^\[?nd\]?$/iu.test(name)) return true;
  return false;
};

export const cleanOrganizations = (
  organizations: ListingOrganization[]
): ListingOrganization[] => {
  const cleaned = organizations
    .map((org) => {
      const normalizedName = cleanTextArtifacts(org.name);
      const normalizedKey = normalizeCenterName(normalizedName) || org.key;
      return {
        ...org,
        name: normalizedName,
        key: normalizedKey,
        address: org.address ? cleanTextArtifacts(org.address) : org.address,
        cities: cleanSet(org.cities),
        regions: cleanSet(org.regions),
        countries: cleanSet(org.countries),
      };
    })
    .filter((org) => !isInvalidOrganization(org));

  logger.info(
    "RNCP listing: nettoyage terminé (%d -> %d organisme(s))",
    organizations.length,
    cleaned.length
  );

  return cleaned;
};

const fetchRecords = async (name: string): Promise<OpenDataRecord[]> => {
  const attempts: Array<Record<string, unknown>> = [
    { dataset: DATASET, rows: MAX_RESULTS, ["refine.denomination"]: name },
    {
      dataset: DATASET,
      rows: MAX_RESULTS,
      q: name,
      sort: "-informationsdeclarees_datedernieredeclaration",
    },
  ];

  for (const params of attempts) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const { data } = await axios.get<OpenDataResponse>(API_URL, { params });
        const recs = data.records ?? [];
        if (recs.length > 0) return recs;
        break;
      } catch (error) {
        if (attempt >= MAX_RETRIES) {
          throw error;
        }
        const delayMs = Math.ceil(
          randomBetween(appConfig.minWaitMs, appConfig.maxWaitMs)
        );
        logger.warn(
          "RNCP listing: erreur OpenDataSoft (%s) tentative %d/%d",
          name,
          attempt + 1,
          MAX_RETRIES + 1
        );
        await humanDelay(delayMs);
      }
    }
  }

  return [];
};

const pickBestRecord = (
  centerName: string,
  records: OpenDataRecord[]
): OpenDataRecord | undefined => {
  const target = normalizeCenterName(centerName);
  const exact = records.find((record) => {
    const denomination = normalize(record.fields.denomination);
    if (!denomination) return false;
    return normalizeCenterName(denomination) === target;
  });
  if (exact) return exact;

  return records[0];
};

export const enrichOrganizationsWithOpenData = async (
  organizations: ListingOrganization[]
): Promise<void> => {
  if (organizations.length === 0) return;

  logger.info(
    "RNCP listing: enrichissement SIREN/SIRET OpenData (%d organisme(s))",
    organizations.length
  );

  let updated = 0;

  for (let index = 0; index < organizations.length; index += 1) {
    const org = organizations[index];
    if (!org.name || (org.siren && org.siret)) continue;

    try {
      const records = await fetchRecords(org.name);
      if (records.length > 0) {
        const best = pickBestRecord(org.name, records);
        if (best) {
          const siren = normalize(best.fields.siren);
          const siret = normalize(best.fields.siretetablissementdeclarant);

          if (siren) org.siren = siren;
          if (siret) org.siret = siret;

          const city = normalize(
            best.fields.adressephysiqueorganismeformation_ville
          );
          const postalCode = normalize(
            best.fields.adressephysiqueorganismeformation_codepostal
          );
          if (city) org.cities.add(city);
          if (postalCode) org.postalCodes.add(postalCode);

          if (siren || siret) {
            updated += 1;
          }
        }
      }
    } catch (error) {
      logger.warn(
        "RNCP listing: enrichissement OpenData échoué pour %s (%s)",
        org.name,
        error instanceof Error ? error.message : String(error)
      );
    }

    if ((index + 1) % 20 === 0) {
      logger.info(
        "RNCP listing: OpenData %d/%d (mis à jour: %d)",
        index + 1,
        organizations.length,
        updated
      );
    }

    await humanDelay(randomBetween(500, 1200));
  }

  logger.info(
    "RNCP listing: enrichissement OpenData terminé (%d organisme(s) enrichi(s))",
    updated
  );
};

