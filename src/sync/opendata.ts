import { Prisma } from "@prisma/client";
import axios from "axios";
import { appConfig } from "../config/appConfig";
import { prisma } from "../db/prisma";
import { normalizeCenterName } from "../utils/center";
import { humanDelay, randomBetween } from "../utils/humanizer";
import { logger } from "../utils/logger";

type Nullable<T> = T | null | undefined;

type OpenDataRecord = {
  fields: {
    denomination?: string;
    siren?: string;
    siretetablissementdeclarant?: string;
    informationsdeclarees_nbstagiaires?: number;
    informationsdeclarees_nbstagiairesconfiesparunautreof?: number;
    informationsdeclarees_effectifformateurs?: number;
    informationsdeclarees_datedernieredeclaration?: string;
    informationsdeclarees_debutexercice?: string;
    numerodeclarationactivite?: string;
    numerosdeclarationactiviteprecedent?: string;
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

/* ----------------------------- Normalisation ----------------------------- */

const normalize = (value: Nullable<string>): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const removeAccents = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "");

const cleanSpaces = (s: string) => s.replace(/\s+/g, " ").trim();

const parseOpenDataDate = (value: Nullable<string>): Date | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const frMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (frMatch) {
    const [, day, month, year] = frMatch;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const fallback = new Date(trimmed);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
};

const CIVILITY_TOKENS = [
  "madame",
  "monsieur",
  "mme",
  "mlle",
  "melle",
  "m.",
  "mr",
  "m",
];

const isCivility = (token: string) =>
  CIVILITY_TOKENS.includes(token.toLowerCase());

/** Retourne tokens NOM/PRENOM sans civilités, accents/ponctuations, lowercased */
const nameTokens = (s: string): string[] => {
  const base = cleanSpaces(removeAccents(s).replace(/[.,;:()'"]/g, " "));
  return base
    .split(/[\s-]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0 && !isCivility(t));
};

/** Vrai si la chaîne contient une civilité explicite */
const hasCivility = (s: string): boolean => {
  const low = s.toLowerCase();
  return CIVILITY_TOKENS.some((c) => low.includes(c));
};

/**
 * Heuristique "personne physique" :
 * - Le record doit contenir une civilité (Madame/Monsieur/…).
 * - Tous les tokens (>=2 recommandé) de la recherche doivent être présents
 *   dans la denomination du record (ordre indifférent, sans accents).
 * - Pas de sous-chaînes : correspondance par token exact.
 */
const isPersonalNameGoodMatch = (
  searchName: string,
  recordDenomination: string
): boolean => {
  if (!hasCivility(recordDenomination)) return false;

  const targetTokens = nameTokens(searchName);
  const recordTokens = nameTokens(recordDenomination);

  // Ex: "LE LAMER Audrey" -> ["le","lamer","audrey"] (>= 2 sinon trop vague)
  if (targetTokens.length < 2) return false;

  // Tous les tokens de la recherche doivent être inclus tels quels dans la denom record
  return targetTokens.every((t) => recordTokens.includes(t));
};

/* ------------------------------- Fetch API ------------------------------- */

/**
 * Tente d'abord un match strict via refine.denomination,
 * puis un fallback en recherche large (q=) uniquement pour récupérer des candidats,
 * mais sans auto-sélection s'il n'y a pas de match exact ensuite.
 */
const fetchRecords = async (name: string): Promise<OpenDataRecord[]> => {
  const base = { dataset: DATASET, rows: MAX_RESULTS };

  const attempts: Array<Record<string, unknown>> = [
    // 1) Match strict sur la dénomination
    { ...base, ["refine.denomination"]: name },
    // 2) Fallback : recherche large (toujours triée par date de dernière déclaration)
    {
      ...base,
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
        // Aucun résultat pour cet essai de paramètres -> on passe au bloc suivant
        break;
      } catch (error) {
        const delayMs = Math.ceil(
          randomBetween(appConfig.minWaitMs, appConfig.maxWaitMs)
        );
        logger.warn(
          "Erreur requête OpenDataSoft (tentative %d/%d) [%s]: %s",
          attempt + 1,
          MAX_RETRIES + 1,
          JSON.stringify(params),
          (error as Error).message
        );
        if (attempt >= MAX_RETRIES) throw error;
        await humanDelay(delayMs);
      }
    }
  }

  return [];
};

/* ---------------------------- Sélection du match ---------------------------- */

/**
 * Règles :
 * 1) On garde le match exact (normalizeCenterName) prioritaire (entreprise).
 * 2) À défaut, si un record a civilité ET que tous les tokens de la recherche
 *    sont inclus dans sa dénomination (ordre libre), on l'accepte (personne).
 * 3) On trie les matches multiples par date de dernière déclaration (desc).
 * 4) Sinon, aucun match.
 */
const pickBestRecord = (
  centerName: string,
  records: OpenDataRecord[]
): OpenDataRecord | undefined => {
  const normalizedTarget = normalizeCenterName(centerName);

  // 1) Exact match (entreprise, ou personne identique mot-à-mot)
  const exactMatches = records.filter((record) => {
    const denomination = normalize(record.fields.denomination);
    if (!denomination) return false;
    const normalizedDenomination = normalizeCenterName(denomination);
    return normalizedDenomination === normalizedTarget;
  });

  if (exactMatches.length > 0) {
    if (exactMatches.length > 1) {
      exactMatches.sort((a, b) => {
        const da = a.fields.informationsdeclarees_datedernieredeclaration ?? "";
        const db = b.fields.informationsdeclarees_datedernieredeclaration ?? "";
        return db.localeCompare(da);
      });
    }
    return exactMatches[0];
  }

  // 2) Fallback "personne physique" (civilité + tokens inclus)
  const personalMatches = records.filter((record) => {
    const denomination = normalize(record.fields.denomination);
    if (!denomination) return false;
    return isPersonalNameGoodMatch(centerName, denomination);
  });

  if (personalMatches.length > 0) {
    if (personalMatches.length > 1) {
      personalMatches.sort((a, b) => {
        const da = a.fields.informationsdeclarees_datedernieredeclaration ?? "";
        const db = b.fields.informationsdeclarees_datedernieredeclaration ?? "";
        return db.localeCompare(da);
      });
    }
    return personalMatches[0];
  }

  // 3) Rien d'acceptable
  return undefined;
};

/* --------------------------------- Update --------------------------------- */

const updateCenterWithRecord = async (
  centerId: number,
  record: OpenDataRecord
) => {
  const payload = record.fields;
  const fiscalYearStart = parseOpenDataDate(
    payload.informationsdeclarees_debutexercice
  );

  const updateData: Prisma.TrainingCenterUpdateInput = {
    siren: payload.siren ?? null,
    siret: payload.siretetablissementdeclarant ?? null,
    declaredTrainees: payload.informationsdeclarees_nbstagiaires ?? null,
    delegatedTrainees:
      payload.informationsdeclarees_nbstagiairesconfiesparunautreof ?? null,
    declaredTrainers: payload.informationsdeclarees_effectifformateurs ?? null,
    fiscalYearStart,
    openDataPayload: payload as Prisma.InputJsonValue,
    openDataUpdatedAt: new Date(),
  };

  await prisma.trainingCenter.update({
    where: { id: centerId },
    data: updateData,
  });
};

/* --------------------------------- Main ---------------------------------- */

export const syncOpenData = async () => {
  const centers = await prisma.trainingCenter.findMany({
    where: {
      OR: [
        { siren: null },
        { siret: null },
        { declaredTrainees: null },
        { declaredTrainers: null },
        { fiscalYearStart: null },
      ],
    },
    orderBy: { id: "asc" },
  });

  if (centers.length === 0) {
    logger.info("Aucun centre à synchroniser.");
    await prisma.$disconnect();
    return;
  }

  logger.info("Synchronisation OpenData pour %d centre(s)", centers.length);

  for (const center of centers) {
    const searchName = normalize(center.name) ?? center.name;
    logger.info("Recherche OpenData pour %s (#%d)", searchName, center.id);

    try {
      const records = await fetchRecords(searchName);
      if (records.length === 0) {
        logger.warn("Aucun enregistrement OpenData trouvé pour %s", searchName);
        continue;
      }

      const bestMatch = pickBestRecord(center.name, records);
      if (!bestMatch) {
        logger.warn(
          'Pas de correspondance acceptable pour "%s" — centre ignoré (ni exact, ni personne avec civilité)',
          searchName
        );
        continue;
      }

      await updateCenterWithRecord(center.id, bestMatch);
      await humanDelay(randomBetween(appConfig.minWaitMs, appConfig.maxWaitMs));
    } catch (error) {
      logger.error(
        "Erreur synchronisation OpenData pour %s: %s",
        searchName,
        (error as Error).message
      );
    }
  }

  await prisma.$disconnect();
};

if (require.main === module) {
  syncOpenData()
    .then(() => {
      logger.info("Synchronisation OpenData terminée");
    })
    .catch((error) => {
      logger.error(
        "Synchronisation OpenData échouée: %s",
        (error as Error).message
      );
      process.exitCode = 1;
    });
}
