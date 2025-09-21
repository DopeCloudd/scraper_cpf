import axios from 'axios';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { normalizeCenterName } from '../utils/center';
import { appConfig } from '../config/appConfig';
import { humanDelay, randomBetween } from '../utils/humanizer';

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
    numerodeclarationactivite?: string;
    numerosdeclarationactiviteprecedent?: string;
    adressephysiqueorganismeformation_ville?: string;
    adressephysiqueorganismeformation_codepostal?: string;
  } & Record<string, unknown>;
};

type OpenDataResponse = {
  records?: OpenDataRecord[];
};

const API_URL = 'https://dgefp.opendatasoft.com/api/records/1.0/search/';
const DATASET = 'liste-publique-des-of-v2';

const MAX_RESULTS = Number(process.env.OPENDATA_ROWS ?? 10);
const MAX_RETRIES = Number(process.env.OPENDATA_RETRIES ?? 2);

const normalize = (value: Nullable<string>): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const fetchRecords = async (name: string): Promise<OpenDataRecord[]> => {
  const params = {
    dataset: DATASET,
    q: name,
    rows: MAX_RESULTS,
    sort: '-informationsdeclarees_datedernieredeclaration',
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const { data } = await axios.get<OpenDataResponse>(API_URL, { params });
      return data.records ?? [];
    } catch (error) {
      const delayMs = Math.ceil(randomBetween(appConfig.minWaitMs, appConfig.maxWaitMs));
      logger.warn(
        'Erreur requête OpenDataSoft (tentative %d/%d): %s',
        attempt + 1,
        MAX_RETRIES + 1,
        (error as Error).message
      );
      if (attempt >= MAX_RETRIES) throw error;
      await humanDelay(delayMs);
    }
  }

  return [];
};

const pickBestRecord = (
  centerName: string,
  records: OpenDataRecord[]
): OpenDataRecord | undefined => {
  const normalizedTarget = normalizeCenterName(centerName);

  const exactMatches = records.filter((record) => {
    const denomination = normalize(record.fields.denomination);
    if (!denomination) return false;
    const normalizedDenomination = normalizeCenterName(denomination);
    return normalizedDenomination === normalizedTarget;
  });

  if (exactMatches.length > 0) {
    return exactMatches[0];
  }

  return records[0];
};

const updateCenterWithRecord = async (centerId: number, record: OpenDataRecord) => {
  const payload = record.fields;

  const updateData: Prisma.TrainingCenterUpdateInput = {
    siren: payload.siren ?? null,
    siret: payload.siretetablissementdeclarant ?? null,
    declaredTrainees: payload.informationsdeclarees_nbstagiaires ?? null,
    delegatedTrainees: payload.informationsdeclarees_nbstagiairesconfiesparunautreof ?? null,
    declaredTrainers: payload.informationsdeclarees_effectifformateurs ?? null,
    openDataPayload: payload as Prisma.InputJsonValue,
    openDataUpdatedAt: new Date(),
  };

  await prisma.trainingCenter.update({
    where: { id: centerId },
    data: updateData,
  });
};

export const syncOpenData = async () => {
  const centers = await prisma.trainingCenter.findMany({
    where: {
      OR: [
        { siren: null },
        { siret: null },
        { declaredTrainees: null },
        { declaredTrainers: null },
      ],
    },
    orderBy: { id: 'asc' },
  });

  if (centers.length === 0) {
    logger.info('Aucun centre à synchroniser.');
    await prisma.$disconnect();
    return;
  }

  logger.info('Synchronisation OpenData pour %d centre(s)', centers.length);

  for (const center of centers) {
    const searchName = normalize(center.name) ?? center.name;
    logger.info('Recherche OpenData pour %s (#%d)', searchName, center.id);

    try {
      const records = await fetchRecords(searchName);
      if (records.length === 0) {
        logger.warn('Aucun enregistrement OpenData trouvé pour %s', searchName);
        continue;
      }

      const bestMatch = pickBestRecord(center.name, records);
      if (!bestMatch) {
        logger.warn('Pas de correspondance valide pour %s', searchName);
        continue;
      }

      await updateCenterWithRecord(center.id, bestMatch);
      await humanDelay(randomBetween(appConfig.minWaitMs, appConfig.maxWaitMs));
    } catch (error) {
      logger.error(
        'Erreur synchronisation OpenData pour %s: %s',
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
      logger.info('Synchronisation OpenData terminée');
    })
    .catch((error) => {
      logger.error('Synchronisation OpenData échouée: %s', (error as Error).message);
      process.exitCode = 1;
    });
}
