import { Prisma } from "@prisma/client";
import type { Browser, Page } from "puppeteer";
import { appConfig } from "../config/appConfig";
import { searchQueries, SearchQuery } from "../config/searchQueries";
import { prisma } from "../db/prisma";
import { createBrowser } from "../scraper/browser";
import {
  normalizeCenterName,
  sanitizeCity,
  sanitizeCountry,
  sanitizePostalCode,
  sanitizeRegion,
} from "../utils/center";
import { humanDelay, randomBetween } from "../utils/humanizer";
import { logger } from "../utils/logger";
import { randomUserAgent } from "../utils/userAgent";

const RESULTS_BASE_URL =
  "https://www.moncompteformation.gouv.fr/espace-prive/html/#/formation/recherche/resultats?q=";
const DETAIL_BASE_URL =
  "https://www.moncompteformation.gouv.fr/espace-prive/html/#/formation/recherche/";

const extractDetailPath = (link?: string | null): string | undefined => {
  if (!link) return undefined;
  let candidate = link;
  try {
    const url = new URL(link, "https://www.moncompteformation.gouv.fr/");
    candidate = url.hash ? url.hash.slice(1) : url.pathname;
  } catch {
    // ignore relative URL parsing errors
  }

  candidate = candidate.replace(/^#/u, "").replace(/^\/+/, "");
  if (!candidate.startsWith("formation/")) return undefined;
  candidate = candidate.replace(/^formation\/(?:recherche|fiche)\//, "");
  candidate = candidate.split("?")[0];
  return candidate || undefined;
};

const buildDetailUrl = (pathValue?: string | null): string | undefined => {
  if (!pathValue) return undefined;
  const segments = String(pathValue)
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));
  if (segments.length === 0) return undefined;
  return `${DETAIL_BASE_URL}${segments.join("/")}`;
};

type JsonRecord = Record<string, unknown>;

type NormalizedListItem = {
  trainingExternalId?: string;
  listPageData: Prisma.InputJsonValue;
  title?: string;
  detailUrl?: string;
  summary?: string;
  modality?: string;
  certification?: string;
  locationText?: string;
  region?: string;
  priceText?: string;
  priceValue?: number;
  durationText?: string;
  durationHours?: number;
  centerName?: string;
  centerExternalId?: string;
  centerCity?: string;
  centerPostalCode?: string;
  centerRegion?: string;
  centerCountry?: string;
};

/** Construit l’URL de recherche initiale (sans pagination par offset) */
const buildSearchUrl = (payload: JsonRecord): string => {
  const json = JSON.stringify(payload);
  return `${RESULTS_BASE_URL}${encodeURIComponent(json)}`;
};

const identifyItemKey = (item: JsonRecord): string => {
  const possibleKeys = [
    "id",
    "idFormation",
    "idOffre",
    "numeroOffre",
    "numeroFormation",
    "code",
    "codeFormation",
    "detailUrl",
    "url",
    "urlFiche",
    "trainingCardId",
  ];

  for (const key of possibleKeys) {
    const value = item[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number") {
      return String(value);
    }
  }

  return JSON.stringify(item);
};

const pickString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return undefined;
};

const pickNumber = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const normalized = value.replace(/[^0-9.,-]/g, "").replace(",", ".");
      const parsed = Number(normalized);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
};

const normalizeListItem = (item: JsonRecord): NormalizedListItem => {
  const organisme = (item.organismeFormation ??
    item.organisme ??
    item.organismeFormateur) as JsonRecord | undefined;
  const localisation = (item.lieuFormation ?? item.localisation) as
    | JsonRecord
    | undefined;
  const rawDetailHref = pickString(
    item.detailUrl,
    item.detailHref,
    item.urlDetail,
    item.url,
    item.urlFiche,
    item.lienDetail
  );

  const trainingId = pickString(
    item.id,
    item.idFormation,
    item.numeroOffre,
    item.numeroFormation,
    item.code,
    item.codeFormation,
    item.numeroAction,
    item.trainingCardId
  );

  const detailPath = pickString(
    extractDetailPath(rawDetailHref),
    item.trainingCardId,
    trainingId
  );

  const detailUrl = buildDetailUrl(detailPath) ?? rawDetailHref;

  const priceValue = pickNumber(
    item.prix,
    item.prixMinimum,
    item.prixMin,
    item.cout,
    item.prixTexte,
    item.priceText
  );
  const durationHours = pickNumber(
    item.dureeHeures,
    item.duree,
    item.dureeTotale,
    item.durationText
  );

  const centerName = pickString(
    organisme?.libelle,
    organisme?.nom,
    organisme?.raisonSociale,
    item.nomOrganisme,
    item.organisme,
    item.centerName
  );

  return {
    trainingExternalId: pickString(
      item.idOffre,
      item.idFormation,
      item.numeroOffre,
      item.codeFormation,
      item.numeroAction,
      item.trainingCardId
    ),
    title: pickString(
      item.libelleFormation,
      item.libelle,
      item.titre,
      item.title
    ),
    detailUrl,
    summary: pickString(
      item.resume,
      item.descriptionCourte,
      item.description,
      item.summary
    ),
    modality: pickString(
      item.modalite,
      item.modality,
      item.modalites,
      item.modaliteLibelle
    ),
    certification: pickString(item.certification, item.certificationLibelle),
    locationText: pickString(
      localisation?.libelle,
      localisation?.ville,
      item.localisation,
      item.ville,
      item.adresse,
      item.locationText
    ),
    region: pickString(localisation?.region, item.region),
    priceText: pickString(
      item.prixTexte,
      item.prixAffiche,
      item.coutAffiche,
      item.priceText
    ),
    priceValue,
    durationText: pickString(
      item.dureeTexte,
      item.duree,
      item.dureeAffiche,
      item.durationText
    ),
    durationHours: durationHours ? Math.round(durationHours) : undefined,
    listPageData: item as Prisma.InputJsonValue,
    centerName,
    centerExternalId: pickString(
      organisme?.id,
      organisme?.siret,
      organisme?.numeroDeclarationActivite
    ),
    centerCity: pickString(localisation?.ville, organisme?.ville),
    centerPostalCode: pickString(
      localisation?.codePostal,
      organisme?.codePostal
    ),
    centerRegion: pickString(localisation?.region, organisme?.region),
    centerCountry: pickString(localisation?.pays, organisme?.pays, "FR"),
  };
};

/* --------------------------- Helpers DOM côté page --------------------------- */

/** Attend la présence d’au moins 1 carte de résultat */
const waitForResults = async (page: Page) => {
  await page.waitForSelector(
    "#result-list-container mcf-dsfr-formation-carte",
    {
      timeout: appConfig.navigationTimeoutMs,
    }
  );
};

/** Récupère le nombre actuel de cartes */
const getCardsCount = async (page: Page): Promise<number> => {
  return page.evaluate(() => {
    const container = document.querySelector("#result-list-container");
    if (!container) return 0;
    return container.querySelectorAll("mcf-dsfr-formation-carte").length;
  });
};

/** Mappe une carte -> objet brut (même logique que précédemment) */
const mapAllCardsToItems = async (page: Page): Promise<JsonRecord[]> => {
  const items = (await page.evaluate(() => {
    const cleanText = (value: string | null | undefined) => {
      if (!value) return undefined;
      const normalized = value.replace(/ | /g, " ").replace(/\s+/g, " ").trim();
      return normalized.length > 0 ? normalized : undefined;
    };

    const getIconText = (card: Element, iconClass: string) => {
      const icon = card.querySelector(`.${iconClass}`);
      if (!icon) return undefined;
      const listItem = icon.closest("li");
      if (!listItem) return undefined;

      const parts = Array.from(listItem.childNodes)
        .map((node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent ?? "";
          }
          if (node instanceof HTMLElement) {
            if (
              node.classList.contains(iconClass) ||
              node.classList.contains("fr-sr-only")
            ) {
              return "";
            }
            return node.textContent ?? "";
          }
          return "";
        })
        .filter((snippet) => snippet && snippet.trim().length > 0);

      return cleanText(parts.join(" "));
    };

    const container = document.querySelector("#result-list-container");
    if (!container) return [] as Array<Record<string, unknown>>;

    const cards = Array.from(
      container.querySelectorAll("mcf-dsfr-formation-carte")
    );
    return cards.map((card) => {
      const titleLink = card.querySelector("h3 a");
      const centerLine = card.querySelector(".form-carte__sous-titre");
      const summary = card.querySelector(".form-carte__certification p");
      const absoluteHref =
        (titleLink as HTMLAnchorElement | null)?.href ?? undefined;
      const rawHref = titleLink?.getAttribute("href") ?? undefined;
      const rawId = (card as HTMLElement | null)?.id || undefined;

      const priceText = getIconText(card, "fr-icon-money-euro-circle-line");
      const durationText = getIconText(card, "fr-icon-time-line");
      const locationText = getIconText(card, "fr-icon-map-pin-2-line");

      const centerNameRaw = cleanText(centerLine?.textContent ?? undefined);
      const centerName =
        centerNameRaw?.replace(/^Proposée par\s*/i, "").trim() || centerNameRaw;

      return {
        title: cleanText(titleLink?.textContent ?? undefined),
        detailUrl: absoluteHref,
        detailHref: rawHref,
        trainingCardId: rawId,
        summary: cleanText(summary?.textContent ?? undefined),
        centerName,
        priceText,
        durationText,
        locationText,
        outerHTML: (card as HTMLElement).outerHTML,
      };
    });
  })) as JsonRecord[];

  return items;
};

/**
 * Extrait uniquement les N derniers items (les "nouveaux") à partir d’un compteur précédent.
 * Exemple: prevCount=10 → retourne les cartes [10..19] (jusqu’à N=10).
 */
const extractNewBatch = async (
  page: Page,
  prevCount: number,
  batchSize = 10
): Promise<JsonRecord[]> => {
  const items = await mapAllCardsToItems(page);
  const total = items.length;
  if (total <= prevCount) return [];
  const start = prevCount;
  const end = Math.min(prevCount + batchSize, total);
  return items.slice(start, end);
};

/** Clique sur “Afficher plus de résultats” s’il est présent */
const clickLoadMoreIfPresent = async (
  page: Page,
  prevCount: number
): Promise<boolean> => {
  // Sélecteur le plus stable: l’attribut aria-describedby et le style DSFR
  const btnSelector =
    'button[aria-describedby="affichage-courant-formations"].fr-btn--tertiary';

  const isPresent = await page.$(btnSelector);
  if (!isPresent) return false;

  await page.click(btnSelector).catch(() => undefined);

  // Attendre que le nombre de cartes augmente (nouveaux 10 résultats)
  try {
    await page.waitForFunction(
      (selector, before) => {
        const container = document.querySelector("#result-list-container");
        if (!container) return false;
        const count = container.querySelectorAll(
          "mcf-dsfr-formation-carte"
        ).length;
        // On veut strictly greater than prevCount
        return count > before;
      },
      { timeout: appConfig.navigationTimeoutMs },
      btnSelector,
      prevCount
    );
  } catch {
    // Si ça n’augmente pas, on considérera qu’il n’y a plus de résultats
    return false;
  }

  // Petit délai humain
  await page.waitForTimeout(
    Math.ceil(randomBetween(appConfig.minWaitMs, appConfig.maxWaitMs))
  );

  return true;
};

/* --------------------------------- Persist --------------------------------- */

const ensureCenter = async (item: NormalizedListItem) => {
  const name = item.centerName?.trim();
  if (!name) return null;

  const normalizedName = normalizeCenterName(name);
  if (!normalizedName) {
    logger.warn("Nom de centre impossible à normaliser: %s", name);
    return null;
  }

  const now = new Date();
  const city = sanitizeCity(item.centerCity);
  const postalCode = sanitizePostalCode(item.centerPostalCode);
  const region = sanitizeRegion(item.centerRegion);
  const country = sanitizeCountry(item.centerCountry) ?? "FR";

  const createData: Prisma.TrainingCenterCreateInput = {
    name,
    normalizedName,
    country,
    lastListScrapedAt: now,
    ...(city ? { city } : {}),
    ...(postalCode ? { postalCode } : {}),
    ...(region ? { region } : {}),
  };

  const updateData: Prisma.TrainingCenterUpdateInput = {
    name,
    normalizedName,
    lastListScrapedAt: now,
  };

  if (city) updateData.city = city;
  if (postalCode) updateData.postalCode = postalCode;
  if (region) updateData.region = region;
  if (country) updateData.country = country;

  if (item.centerExternalId) {
    return prisma.trainingCenter.upsert({
      where: { externalId: item.centerExternalId },
      update: updateData,
      create: {
        ...createData,
        externalId: item.centerExternalId,
      },
    });
  }

  const existing = await prisma.trainingCenter.findFirst({
    where: { normalizedName },
  });

  if (existing) {
    return prisma.trainingCenter.update({
      where: { id: existing.id },
      data: updateData,
    });
  }

  return prisma.trainingCenter.create({
    data: createData,
  });
};

const persistListItem = async (
  normalized: NormalizedListItem,
  query: SearchQuery
): Promise<boolean> => {
  if (!normalized.title || !normalized.detailUrl) {
    logger.warn(
      "Item ignoré (title/detailUrl manquant): %o",
      normalized.listPageData
    );
    return false;
  }

  const center = await ensureCenter(normalized);
  if (!center) {
    logger.warn("Centre non déterminé pour %s", normalized.title);
    return false;
  }

  const now = new Date();
  const priceDecimal =
    typeof normalized.priceValue === "number"
      ? new Prisma.Decimal(normalized.priceValue.toFixed(2))
      : undefined;

  const existingTraining = await prisma.training.findUnique({
    where: { detailUrl: normalized.detailUrl },
    select: { id: true },
  });

  const commonData = {
    centerId: center.id,
    externalId: normalized.trainingExternalId ?? null,
    title: normalized.title,
    summary: normalized.summary,
    modality: normalized.modality,
    certification: normalized.certification,
    locationText: normalized.locationText,
    region: normalized.region,
    priceText: normalized.priceText,
    priceValue: priceDecimal ?? null,
    durationText: normalized.durationText,
    durationHours: normalized.durationHours ?? null,
    searchQuery: query.name,
    needsDetail: true,
    listPageData: normalized.listPageData as Prisma.InputJsonValue,
    lastListScrapedAt: now,
  };

  if (existingTraining) {
    await prisma.training.update({
      where: { id: existingTraining.id },
      data: commonData,
    });
    return true;
  }

  const centerAlreadyHasTraining = await prisma.training.findFirst({
    where: { centerId: center.id },
    select: { id: true },
  });

  if (centerAlreadyHasTraining) {
    logger.debug(
      "Formation ignorée car le centre possède déjà une formation (centerId=%s)",
      center.id
    );
    return false;
  }

  await prisma.training.create({
    data: {
      ...commonData,
      detailUrl: normalized.detailUrl,
    },
  });

  return true;
};

/* ----------------------------- Process par query ---------------------------- */

const processQuery = async (browser: Browser, query: SearchQuery) => {
  const page = await browser.newPage();
  await page.setDefaultNavigationTimeout(appConfig.navigationTimeoutMs);
  await page.setUserAgent(randomUserAgent());
  await page.setExtraHTTPHeaders({
    "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
  });

  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const resourceType = request.resourceType();
    if (["image", "media", "font"].includes(resourceType)) {
      request.abort().catch(() => undefined);
      return;
    }
    request.continue().catch(() => undefined);
  });

  const basePayload = JSON.parse(JSON.stringify(query.payload)) as JsonRecord;

  const processedKeys = new Set<string>();
  let prevCount = 0; // nombre de cartes déjà traitées
  let totalSaved = 0;
  let batchIndex = 0;

  try {
    // 1) Navigation initiale
    const url = buildSearchUrl(basePayload);
    logger.info("Extraction liste %s — page initiale via %s", query.name, url);

    try {
      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: appConfig.navigationTimeoutMs,
      });
    } catch (error) {
      logger.warn(
        "Échec navigation vers %s : %s",
        url,
        (error as Error).message
      );
    }

    await waitForResults(page);
    await page.waitForTimeout(
      Math.ceil(randomBetween(appConfig.minWaitMs, appConfig.maxWaitMs))
    );

    while (batchIndex < appConfig.maxPagesPerQuery) {
      // 2) Extraire uniquement les 10 "nouveaux" résultats
      const rawNewItems = await extractNewBatch(page, prevCount, 10);

      if (rawNewItems.length === 0) {
        // Si pas de nouveaux items, tenter un clic "Afficher plus de résultats"
        const clicked = await clickLoadMoreIfPresent(page, prevCount);
        if (!clicked) {
          logger.info(
            "Fin atteinte (bouton absent ou plus de nouveaux résultats) pour %s",
            query.name
          );
          break;
        }

        // Après le clic, tenter à nouveau d’extraire les nouveaux
        const retriedNew = await extractNewBatch(page, prevCount, 10);
        if (retriedNew.length === 0) {
          logger.info(
            "Aucun nouvel item après clic pour %s — arrêt",
            query.name
          );
          break;
        }

        // Traiter ces nouveaux items
        for (const raw of retriedNew) {
          const key = identifyItemKey(raw);
          if (processedKeys.has(key)) continue;
          processedKeys.add(key);

          const normalized = normalizeListItem(raw);
          normalized.listPageData = raw as Prisma.InputJsonValue;

          try {
            const saved = await persistListItem(normalized, query);
            if (saved) totalSaved += 1;
          } catch (error) {
            logger.error(
              "Échec sauvegarde formation: %s",
              (error as Error).message,
              { detailUrl: normalized.detailUrl }
            );
          }
        }

        prevCount += retriedNew.length;
        batchIndex += 1;

        // Préparer l’éventuel prochain tour
        // (le clic suivant se fera en début de boucle si nécessaire)
        continue;
      }

      // 3) Traiter les nouveaux items détectés sans cliquer (premier lot initial)
      for (const raw of rawNewItems) {
        const key = identifyItemKey(raw);
        if (processedKeys.has(key)) continue;
        processedKeys.add(key);

        const normalized = normalizeListItem(raw);
        normalized.listPageData = raw as Prisma.InputJsonValue;

        try {
          const saved = await persistListItem(normalized, query);
          if (saved) totalSaved += 1;
        } catch (error) {
          logger.error(
            "Échec sauvegarde formation: %s",
            (error as Error).message,
            { detailUrl: normalized.detailUrl }
          );
        }
      }

      prevCount += rawNewItems.length;
      batchIndex += 1;

      // 4) Clic pour charger 10 de plus pour la prochaine itération
      const clicked = await clickLoadMoreIfPresent(page, prevCount);
      if (!clicked) {
        logger.info(
          "Fin atteinte (bouton absent) pour %s après %d lots",
          query.name,
          batchIndex
        );
        break;
      }
    }

    logger.info(
      "Extraction terminée pour %s avec %d éléments",
      query.name,
      totalSaved
    );
  } finally {
    page.removeAllListeners("request");
    await page.close();
  }
};

export const runExtraction = async (queries: SearchQuery[] = searchQueries) => {
  const browser = await createBrowser();

  try {
    for (const query of queries) {
      await processQuery(browser, query);
      await humanDelay(randomBetween(1500, 4000));
    }
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
};
