import { runExtraction } from './extract';
import { searchQueries } from './config/searchQueries';
import { logger } from './utils/logger';

interface CliOptions {
  queryNames: string[];
  help: boolean;
}

const normalizeQueryNames = (rawValues: string[]): string[] =>
  rawValues
    .flatMap((rawValue) => rawValue.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

const parseCli = (): CliOptions => {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    queryNames: [],
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      break;
    }

    if (arg.startsWith('--query=')) {
      const value = arg.split('=')[1];
      options.queryNames.push(...normalizeQueryNames(value ? [value] : []));
      continue;
    }

    if (arg === '--query' || arg === '-q') {
      const values: string[] = [];
      let lookahead = index + 1;

      while (lookahead < args.length) {
        const candidate = args[lookahead];

        if (candidate.startsWith('-')) {
          break;
        }

        values.push(candidate);
        lookahead += 1;
      }

      options.queryNames.push(...normalizeQueryNames(values));
      index = lookahead - 1;
      continue;
    }
  }

  return options;
};

const showHelp = () => {
  // eslint-disable-next-line no-console
  console.log(`Usage: npm run dev -- [options]\n\nOptions:\n  -q, --query <name...> Exécute uniquement les requêtes spécifiées.\n                         Accepte plusieurs valeurs séparées par des espaces ou\n                         des virgules (ex: -q anglais paris) ou un raccourci\n                         thème (ex: anglais) pour toutes les variantes.\n  -h, --help            Affiche cette aide\n\nRequêtes disponibles :\n  ${searchQueries.map((query) => `- ${query.name}`).join('\n  ')}`);
};

const main = async () => {
  const options = parseCli();

  if (options.help) {
    showHelp();
    return;
  }

  const { queryNames } = options;
  let queriesToRun = searchQueries;
  let unknownQueries: string[] = [];

  if (queryNames.length > 0) {
    const matchedNames = new Set<string>();
    const misses: string[] = [];

    for (const requested of queryNames) {
      let hasMatch = false;

      for (const query of searchQueries) {
        if (
          query.name === requested ||
          query.name.startsWith(`${requested}-`)
        ) {
          matchedNames.add(query.name);
          hasMatch = true;
        }
      }

      if (!hasMatch) {
        misses.push(requested);
      }
    }

    queriesToRun = searchQueries.filter((query) => matchedNames.has(query.name));
    unknownQueries = misses;
  }

  if (unknownQueries.length > 0) {
    logger.warn('Requêtes inconnues ignorées: %s', unknownQueries.join(', '));
  }

  if (queriesToRun.length === 0) {
    logger.error('Aucune requête à exécuter. Utilisez --help pour la liste des requêtes.');
    process.exitCode = 1;
    return;
  }

  logger.info('Lancement extraction pour %d requête(s)', queriesToRun.length);

  const startedAt = Date.now();

  try {
    await runExtraction(queriesToRun);
    const durationMs = Date.now() - startedAt;
    logger.info('Extraction terminée (%d ms)', durationMs);
  } catch (error) {
    logger.error('Erreur lors de l\'extraction: %s', (error as Error).message, {
      stack: (error as Error).stack,
    });
    process.exitCode = 1;
  }
};

main().catch((error) => {
  logger.error('Erreur non gérée: %s', (error as Error).message, {
    stack: (error as Error).stack,
  });
  process.exitCode = 1;
});
