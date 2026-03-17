import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import type { Browser, Page } from "puppeteer";
import { appConfig } from "../config/appConfig";
import { createBrowser } from "../scraper/browser";
import { normalizeCenterName } from "../utils/center";
import { humanDelay, randomBetween } from "../utils/humanizer";
import { logger } from "../utils/logger";
import { randomUserAgent } from "../utils/userAgent";

type JsonRecord = Record<string, unknown>;

interface CliOptions {
  codes: string[];
  outputFile?: string;
  fetchDetails: boolean;
  maxPagesPerCode: number;
  help: boolean;
}

type OrganizationAggregate = {
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
};

type CardItem = {
  centerName?: string;
  detailUrl?: string;
  locationText?: string;
};

type SearchVariant = {
  name: "presentiel-paris" | "distanciel";
  payload: JsonRecord;
};

const RESULTS_BASE_URL =
  "https://www.moncompteformation.gouv.fr/espace-prive/html/#/formation/recherche/resultats?q=";
const DETAIL_BASE_URL =
  "https://www.moncompteformation.gouv.fr/espace-prive/html/#/formation/recherche/";

const DEFAULT_RNCP_CODES = [
  "RNCP37948",
  "RNCP37121",
  "RNCP37949",
  "RNCP37123",
  "RNCP41366",
  "RNCP38037",
  "RNCP41239",
];

const PARIS_CITY = {
  nom: "PARIS",
  codePostal: "75000",
  codeInsee: "75056",
  coordonnee: {
    longitude: 2.342562,
    latitude: 48.85653,
  },
  eligibleCpf: true,
};

const parseCsvLikeValues = (rawValues: string[]): string[] =>
  rawValues
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

const normalizeRncpCode = (value: string): string | undefined => {
  const cleaned = value.toUpperCase().replace(/\s+/g, "");
  if (!cleaned) return undefined;

  if (/^RNCP\d+$/u.test(cleaned)) return cleaned;
  if (/^\d+$/u.test(cleaned)) return `RNCP${cleaned}`;
  return undefined;
};

const unique = (values: string[]): string[] => Array.from(new Set(values));

const toPositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  return rounded > 0 ? rounded : fallback;
};

const parseCli = (): CliOptions => {
  const args = process.argv.slice(2);

  const envCodes = process.env.RNCP_CODES
    ? parseCsvLikeValues([process.env.RNCP_CODES])
    : [];

  const options: CliOptions = {
    codes: envCodes,
    outputFile: undefined,
    fetchDetails: true,
    maxPagesPerCode: appConfig.maxPagesPerQuery,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      break;
    }

    if (arg === "--no-details") {
      options.fetchDetails = false;
      continue;
    }

    if (arg.startsWith("--output=")) {
      const value = arg.split("=")[1];
      if (value) options.outputFile = value.trim();
      continue;
    }

    if (arg === "--output") {
      const value = args[index + 1];
      if (value && !value.startsWith("-")) {
        options.outputFile = value.trim();
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("--max-pages-per-code=")) {
      const value = arg.split("=")[1];
      options.maxPagesPerCode = toPositiveInt(value, options.maxPagesPerCode);
      continue;
    }

    if (arg === "--max-pages-per-code") {
      const value = args[index + 1];
      if (value && !value.startsWith("-")) {
        options.maxPagesPerCode = toPositiveInt(value, options.maxPagesPerCode);
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("--codes=")) {
      const value = arg.split("=")[1];
      options.codes.push(...parseCsvLikeValues(value ? [value] : []));
      continue;
    }

    if (arg === "--codes" || arg === "-c") {
      const values: string[] = [];
      let lookahead = index + 1;

      while (lookahead < args.length) {
        const candidate = args[lookahead];
        if (candidate.startsWith("-")) break;
        values.push(candidate);
        lookahead += 1;
      }

      options.codes.push(...parseCsvLikeValues(values));
      index = lookahead - 1;
    }
  }

  const normalizedCodes = unique(
    options.codes
      .map((code) => normalizeRncpCode(code))
      .filter((code): code is string => Boolean(code))
  );

  if (normalizedCodes.length === 0) {
    options.codes = [...DEFAULT_RNCP_CODES];
  } else {
    options.codes = normalizedCodes;
  }

  return options;
};

const showHelp = () => {
  // eslint-disable-next-line no-console
  console.log(`Usage: npm run rncp:listing -- [options]\n\nOptions:\n  -c, --codes <code...>        Codes RNCP cibles (ex: RNCP37121 RNCP37948).\n                               Accepte espaces ou virgules.\n  --max-pages-per-code <n>     Limite de pagination par code RNCP.\n  --no-details                 N'ouvre pas les fiches détail (plus rapide, moins d'infos).\n  --output <path>              Chemin de sortie CSV.\n  -h, --help                   Affiche cette aide\n\nVariables d'environnement:\n  RNCP_CODES=RNCP37121,RNCP37948\n\nPar défaut (si aucun code fourni), les codes suivants sont utilisés:\n  ${DEFAULT_RNCP_CODES.join(", ")}`);
};

const buildCommonPayloadForRncp = (rncpCode: string): JsonRecord => ({
  debutPagination: 1,
  nombreOccurences: 10,
  contexteFormation: "ACTIVITE_PROFESSIONNELLE",
  nomOrganisme: null,
  conformiteReglementaire: null,
  endDate: null,
  startDate: null,
  evaluation: null,
  niveauSortie: null,
  minPrix: null,
  maxPrix: null,
  rythme: null,
  onlyWithAbondementsEligibles: null,
  durationHours: null,
  certifications: null,
  quoi: null,
  quoiReferentiel: {
    code: rncpCode,
    libelle: rncpCode,
    type: "CERTIFICATION",
    publics: ["GD_PUBLIC"],
  },
});

const buildSearchVariantsForRncp = (rncpCode: string): SearchVariant[] => {
  const common = buildCommonPayloadForRncp(rncpCode);

  return [
    {
      name: "presentiel-paris",
      payload: {
        ...common,
        ou: {
          modality: "EN_CENTRE_MIXTE",
          type: "CP",
          ville: PARIS_CITY,
        },
        // Distance volontairement non bornée.
        distance: null,
      },
    },
    {
      name: "distanciel",
      payload: {
        ...common,
        ou: {
          modality: "A_DISTANCE",
          type: "CP",
        },
        distance: null,
      },
    },
  ];
};

const buildSearchUrl = (payload: JsonRecord): string => {
  const json = JSON.stringify(payload);
  return `${RESULTS_BASE_URL}${encodeURIComponent(json)}`;
};

const pickString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const cleaned = value.trim();
    if (cleaned) return cleaned;
  }
  return undefined;
};

const extractDetailPath = (link?: string): string | undefined => {
  if (!link) return undefined;

  let candidate = link;
  try {
    const url = new URL(link, "https://www.moncompteformation.gouv.fr/");
    candidate = url.hash ? url.hash.slice(1) : url.pathname;
  } catch {
    // ignore parsing issues for relative links
  }

  candidate = candidate.replace(/^#/u, "").replace(/^\/+/, "");
  if (!candidate.startsWith("formation/")) return undefined;
  candidate = candidate.replace(/^formation\/(?:recherche|fiche)\//, "");
  candidate = candidate.split("?")[0];

  return candidate || undefined;
};

const buildDetailUrl = (pathValue?: string): string | undefined => {
  if (!pathValue) return undefined;

  const segments = String(pathValue)
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));

  if (segments.length === 0) return undefined;
  return `${DETAIL_BASE_URL}${segments.join("/")}`;
};

const waitForResults = async (page: Page): Promise<void> => {
  await Promise.race([
    page.waitForSelector("#result-list-container mcf-dsfr-formation-carte", {
      timeout: appConfig.navigationTimeoutMs,
    }),
    page.waitForSelector("#result-list-container", {
      timeout: appConfig.navigationTimeoutMs,
    }),
  ]);
};

const mapAllCards = async (page: Page): Promise<CardItem[]> => {
  const rows = await page.evaluate(() => {
    const cleanText = (value: string | null | undefined): string | undefined => {
      if (!value) return undefined;
      const cleaned = value.replace(/\s+/g, " ").trim();
      return cleaned.length > 0 ? cleaned : undefined;
    };

    const container = document.querySelector("#result-list-container");
    if (!container) return [] as Array<Record<string, unknown>>;

    const cards = Array.from(
      container.querySelectorAll("mcf-dsfr-formation-carte")
    );

    return cards.map((card) => {
      const titleLink = card.querySelector("h3 a") as HTMLAnchorElement | null;
      const centerLine = card.querySelector(".form-carte__sous-titre");
      const locationIcon = card.querySelector(".fr-icon-map-pin-2-line");
      const locationLine = locationIcon?.closest("li");

      const centerNameRaw = cleanText(centerLine?.textContent ?? undefined);
      const centerName =
        centerNameRaw?.replace(/^Proposée par\s*/i, "").trim() || centerNameRaw;

      return {
        centerName,
        detailHref: titleLink?.getAttribute("href") ?? undefined,
        detailUrl: titleLink?.href ?? undefined,
        locationText: cleanText(locationLine?.textContent ?? undefined),
      };
    });
  });

  return rows.map((row) => {
    const rawUrl = pickString(row.detailUrl, row.detailHref);
    const detailPath = extractDetailPath(rawUrl);
    return {
      centerName: pickString(row.centerName),
      detailUrl: buildDetailUrl(detailPath) ?? rawUrl,
      locationText: pickString(row.locationText),
    };
  });
};

const extractNewBatch = async (
  page: Page,
  prevCount: number,
  batchSize = 10
): Promise<CardItem[]> => {
  const items = await mapAllCards(page);
  const total = items.length;
  if (total <= prevCount) return [];
  return items.slice(prevCount, Math.min(prevCount + batchSize, total));
};

const clickLoadMoreIfPresent = async (
  page: Page,
  prevCount: number
): Promise<boolean> => {
  const btnSelector =
    'button[aria-describedby="affichage-courant-formations"].fr-btn--tertiary';

  const isPresent = await page.$(btnSelector);
  if (!isPresent) return false;

  await page.click(btnSelector).catch(() => undefined);

  try {
    await page.waitForFunction(
      (before) => {
        const container = document.querySelector("#result-list-container");
        if (!container) return false;
        const count = container.querySelectorAll(
          "mcf-dsfr-formation-carte"
        ).length;
        return count > before;
      },
      { timeout: appConfig.navigationTimeoutMs },
      prevCount
    );
  } catch {
    return false;
  }

  await page.waitForTimeout(
    Math.ceil(randomBetween(appConfig.minWaitMs, appConfig.maxWaitMs))
  );

  return true;
};

const setupPage = async (page: Page): Promise<void> => {
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
};

const addLocationHints = (
  aggregate: OrganizationAggregate,
  locationText?: string
): void => {
  if (!locationText) return;

  const cleaned = locationText.replace(/^Localisation\s*:?/i, "").trim();
  if (!cleaned) return;

  const postalMatches = cleaned.match(/\b\d{5}\b/g);
  if (postalMatches) {
    for (const postalCode of postalMatches) {
      aggregate.postalCodes.add(postalCode);
    }
  }

  const noPostal = cleaned.replace(/\b\d{5}\b/g, " ").replace(/\s+/g, " ").trim();
  if (noPostal) {
    aggregate.cities.add(noPostal);
  }
};

const upsertOrganization = (
  organizations: Map<string, OrganizationAggregate>,
  rncpCode: string,
  item: CardItem
): void => {
  const centerName = item.centerName?.trim();
  if (!centerName) return;

  const key = normalizeCenterName(centerName);
  if (!key) return;

  const existing = organizations.get(key);
  if (!existing) {
    const created: OrganizationAggregate = {
      key,
      name: centerName,
      rncpCodes: new Set([rncpCode]),
      cities: new Set<string>(),
      postalCodes: new Set<string>(),
      regions: new Set<string>(),
      countries: new Set<string>(),
      trainingCount: 1,
      detailUrl: item.detailUrl,
    };

    addLocationHints(created, item.locationText);
    organizations.set(key, created);
    return;
  }

  existing.rncpCodes.add(rncpCode);
  existing.trainingCount += 1;
  if (!existing.detailUrl && item.detailUrl) {
    existing.detailUrl = item.detailUrl;
  }
  addLocationHints(existing, item.locationText);
};

const parseDetailContacts = async (
  page: Page
): Promise<Pick<OrganizationAggregate, "email" | "phone" | "website" | "address">> => {
  return page
    .evaluate(() => {
      const cleanText = (value?: string | null): string | undefined =>
        value?.replace(/\s+/g, " ").trim() || undefined;

      const liElements = Array.from(document.querySelectorAll("li"));

      const phoneLi = liElements.find((li) =>
        li.querySelector('span[class*="fr-icon-phone"]')
      );
      let phone: string | undefined;
      if (phoneLi) {
        const phoneAnchor = phoneLi.querySelector(
          'a[href^="tel:"]'
        ) as HTMLAnchorElement | null;
        if (phoneAnchor?.href) {
          phone = phoneAnchor.href.replace(/^tel:/i, "").trim();
        } else {
          const phoneText = cleanText(phoneLi.textContent);
          const phoneMatch = phoneText?.match(/(?:\+?\d[\d\s.\-]{5,})/);
          if (phoneMatch) phone = phoneMatch[0].replace(/[^\d+]/g, "");
        }
      }

      const emailLi = liElements.find((li) =>
        li.querySelector('span[class*="fr-icon-mail"]')
      );
      let email: string | undefined;
      if (emailLi) {
        const emailAnchor = emailLi.querySelector(
          'a[href^="mailto:"]'
        ) as HTMLAnchorElement | null;
        if (emailAnchor?.href) {
          email = emailAnchor.href.replace(/^mailto:/i, "").trim();
        }
      }

      let website: string | undefined;
      const websiteAnchor = document.querySelector(
        'a[href^="http"]'
      ) as HTMLAnchorElement | null;
      if (websiteAnchor?.href) {
        website = websiteAnchor.href.trim();
      }

      const address = cleanText(
        document.querySelector("li.bloc-info.localisation .soustitre")
          ?.textContent
      );

      return {
        email,
        phone,
        website,
        address,
      };
    })
    .catch(() => ({
      email: undefined,
      phone: undefined,
      website: undefined,
      address: undefined,
    }));
};

const enrichOrganizationsWithDetail = async (
  browser: Browser,
  organizations: OrganizationAggregate[]
): Promise<void> => {
  if (organizations.length === 0) return;

  const page = await browser.newPage();
  await setupPage(page);

  try {
    for (let index = 0; index < organizations.length; index += 1) {
      const org = organizations[index];
      if (!org.detailUrl) continue;

      try {
        await page.setUserAgent(randomUserAgent());
        await page.goto(org.detailUrl, {
          waitUntil: "networkidle2",
          timeout: appConfig.navigationTimeoutMs,
        });

        await page.waitForTimeout(
          Math.ceil(randomBetween(appConfig.minWaitMs, appConfig.maxWaitMs))
        );

        const details = await parseDetailContacts(page);

        if (details.email && !org.email) org.email = details.email;
        if (details.phone && !org.phone) org.phone = details.phone;
        if (details.website && !org.website) org.website = details.website;
        if (details.address && !org.address) org.address = details.address;
      } catch (error) {
        logger.warn(
          "RNCP listing: impossible de lire le détail pour %s (%s)",
          org.name,
          error instanceof Error ? error.message : String(error)
        );
      }

      if ((index + 1) % 20 === 0) {
        logger.info(
          "RNCP listing: enrichissement détail %d/%d",
          index + 1,
          organizations.length
        );
      }

      await humanDelay(randomBetween(1200, 2500));
    }
  } finally {
    page.removeAllListeners("request");
    await page.close().catch(() => undefined);
  }
};

const csvEscape = (value: unknown): string => {
  if (value == null) return "";
  const stringValue = String(value);
  if (
    stringValue.includes(";") ||
    stringValue.includes('"') ||
    stringValue.includes("\n") ||
    stringValue.includes("\r")
  ) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
};

const joinSet = (values: Set<string>, separator = " | "): string =>
  Array.from(values)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .sort((a, b) => a.localeCompare(b, "fr"))
    .join(separator);

const defaultOutputPath = (): string => {
  const dir = process.env.EXPORT_DIR ?? "exports";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `rncp_listing_${timestamp}.csv`);
};

const writeCsv = async (
  outputPath: string,
  organizations: OrganizationAggregate[]
): Promise<void> => {
  const headers = [
    "organisme_nom",
    "organisme_cle",
    "organisme_villes",
    "organisme_codes_postaux",
    "organisme_regions",
    "organisme_pays",
    "organisme_email",
    "organisme_telephone",
    "organisme_site",
    "organisme_adresse",
    "rncp_codes",
    "rncp_codes_count",
    "formations_count",
    "formation_detail_url_exemple",
  ];

  const lines = [headers.map(csvEscape).join(";")];

  const sorted = [...organizations].sort((a, b) =>
    a.name.localeCompare(b.name, "fr")
  );

  for (const org of sorted) {
    const rncpCodes = Array.from(org.rncpCodes).sort((a, b) =>
      a.localeCompare(b, "fr")
    );

    lines.push(
      [
        org.name,
        org.key,
        joinSet(org.cities),
        joinSet(org.postalCodes),
        joinSet(org.regions),
        joinSet(org.countries),
        org.email ?? "",
        org.phone ?? "",
        org.website ?? "",
        org.address ?? "",
        rncpCodes.join(" | "),
        rncpCodes.length,
        org.trainingCount,
        org.detailUrl ?? "",
      ]
        .map(csvEscape)
        .join(";")
    );
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
};

const scrapeRncpCode = async (
  browser: Browser,
  rncpCode: string,
  organizations: Map<string, OrganizationAggregate>,
  maxPagesPerCode: number
): Promise<void> => {
  const variants = buildSearchVariantsForRncp(rncpCode);
  let totalMatchedForCode = 0;

  for (const variant of variants) {
    const page = await browser.newPage();
    await setupPage(page);

    try {
      const url = buildSearchUrl(variant.payload);

      logger.info(
        "RNCP listing: extraction %s (%s)",
        rncpCode,
        variant.name
      );

      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: appConfig.navigationTimeoutMs,
      });

      await waitForResults(page);
      await page.waitForTimeout(
        Math.ceil(randomBetween(appConfig.minWaitMs, appConfig.maxWaitMs))
      );

      const processedKeys = new Set<string>();
      let prevCount = 0;
      let pageIndex = 0;
      let matchedForVariant = 0;

      while (pageIndex < maxPagesPerCode) {
        const rawNewItems = await extractNewBatch(page, prevCount, 10);

        if (rawNewItems.length === 0) {
          const clicked = await clickLoadMoreIfPresent(page, prevCount);
          if (!clicked) break;

          const retriedItems = await extractNewBatch(page, prevCount, 10);
          if (retriedItems.length === 0) break;

          for (const item of retriedItems) {
            const key = `${item.centerName ?? ""}|${item.detailUrl ?? ""}`;
            if (!key.trim() || processedKeys.has(key)) continue;
            processedKeys.add(key);
            upsertOrganization(organizations, rncpCode, item);
            matchedForVariant += 1;
          }

          prevCount += retriedItems.length;
          pageIndex += 1;
          continue;
        }

        for (const item of rawNewItems) {
          const key = `${item.centerName ?? ""}|${item.detailUrl ?? ""}`;
          if (!key.trim() || processedKeys.has(key)) continue;
          processedKeys.add(key);
          upsertOrganization(organizations, rncpCode, item);
          matchedForVariant += 1;
        }

        prevCount += rawNewItems.length;
        pageIndex += 1;

        const clicked = await clickLoadMoreIfPresent(page, prevCount);
        if (!clicked) break;
      }

      totalMatchedForCode += matchedForVariant;

      logger.info(
        "RNCP listing: %s (%s) terminé (%d formation(s) lue(s))",
        rncpCode,
        variant.name,
        matchedForVariant
      );
    } finally {
      page.removeAllListeners("request");
      await page.close().catch(() => undefined);
    }
  }

  logger.info(
    "RNCP listing: %s terminé (%d formation(s) lue(s), tous modes)",
    rncpCode,
    totalMatchedForCode
  );
};

export const runRncpListing = async (options: CliOptions): Promise<string> => {
  const browser = await createBrowser();

  try {
    const organizations = new Map<string, OrganizationAggregate>();

    for (const rncpCode of options.codes) {
      try {
        await scrapeRncpCode(
          browser,
          rncpCode,
          organizations,
          options.maxPagesPerCode
        );
      } catch (error) {
        logger.error(
          "RNCP listing: erreur extraction %s: %s",
          rncpCode,
          error instanceof Error ? error.message : String(error)
        );
      }

      await humanDelay(randomBetween(1500, 3500));
    }

    const rows = Array.from(organizations.values());

    if (options.fetchDetails && rows.length > 0) {
      logger.info(
        "RNCP listing: enrichissement des infos organisme (%d ligne(s))",
        rows.length
      );
      await enrichOrganizationsWithDetail(browser, rows);
    }

    const outputPath = options.outputFile?.trim() || defaultOutputPath();
    await writeCsv(outputPath, rows);

    logger.info(
      "RNCP listing: export terminé (%d organisme(s)) -> %s",
      rows.length,
      outputPath
    );

    return outputPath;
  } finally {
    await browser.close().catch(() => undefined);
  }
};

if (require.main === module) {
  const options = parseCli();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  logger.info(
    "RNCP listing: démarrage pour %d code(s): %s",
    options.codes.length,
    options.codes.join(", ")
  );

  runRncpListing(options)
    .then((outputPath) => {
      logger.info("RNCP listing: fichier généré -> %s", outputPath);
      process.exitCode = 0;
    })
    .catch((error) => {
      logger.error(
        "RNCP listing échoué: %s",
        error instanceof Error ? error.message : String(error)
      );
      process.exitCode = 1;
    });
}
