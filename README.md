# scraper_cpf

Collecte, enrichissement et export de données MonCompteFormation.

## Prérequis

- Node.js 18+
- Base MySQL accessible (valeur pour `DATABASE_URL`)
- `npm install` exécuté dans le dossier du projet

## Configuration (.env)

Copier `.env` et ajuster si besoin :

```
DATABASE_URL=mysql://user:password@host:3306/scraper_cpf

# Pilotage du navigateur
PUPPETEER_HEADLESS=false        # true pour exécuter sans interface
PUPPETEER_SLOWMO=0              # délai (ms) entre les actions Puppeteer
MAX_PAGES_PER_QUERY=2000        # pagination maximale par requête
ITEMS_PER_PAGE=10               # nb d'éléments demandés par page
MIN_WAIT_MS=750                 # delai min (ms) aléatoire entre les pages
MAX_WAIT_MS=2000                # délai max (ms)
NAVIGATION_TIMEOUT_MS=45000     # timeout navigation Puppeteer
DETAIL_BATCH_SIZE=10            # nb de fiches enrichies par lot

# Journalisation / divers
LOG_LEVEL=info                  # debug, info, warn, error...
NODE_ENV=development            # active les logs Prisma détaillés

# Export CSV/Excel
EXPORT_DIR=exports              # dossier cible
EXPORT_PAGE_SIZE=1000           # pagination DB pour l'export

# Synchronisation open data
OPENDATA_ROWS=10                # nb de résultats à récupérer
OPENDATA_RETRIES=2              # tentatives avant abandon
```

## Commandes npm

- `npm run extract -- [options]` : scrape des formations depuis MonCompteFormation.
  - `-q, --query <nom...>` ou `--query=nom`: limite aux requêtes indiquées (alias accepté : si vous passez `anglais`, toutes les requêtes `anglais-*` sont exécutées).
  - `-c, --city <slug...>` ou `--city=slug`: limite aux villes présentes dans le nom de la requête (`-c lyon paris`).
  - `--no-shuffle` : exécute les requêtes dans l'ordre déclaré (sinon l'ordre est aléatoire à chaque run).
  - `-h, --help` : affiche l'aide avec la liste des requêtes disponibles.
  - Sans option, toutes les requêtes de `searchQueries.ts` sont traitées.
- `npm run enrich` : visite les fiches en attente pour récupérer les détails (contacts, description HTML, etc.). Aucune option.
- `npm run sync:opendata` : synchronise les données centres depuis l'open data. Aucune option.
- `npm run rncp:listing -- [options]` : génère un fichier CSV agrégé par organisme pour une liste de codes RNCP, sans écrire en base.
  - `-c, --codes <code...>` ou `--codes=RNCP37121,RNCP37948` : codes RNCP à cibler.
  - `--max-pages-per-code <n>` : limite de pagination par code.
  - `--no-details` : n'ouvre pas les fiches de détail (plus rapide, moins d'infos organisme).
  - `--output <path>` : chemin du fichier CSV de sortie.
  - Sans option, utilise la liste RNCP par défaut du script.
- `npm run export -- [options]` : génère un ou plusieurs fichiers Excel dans `EXPORT_DIR`.
  - `--centers-only` / `--centres-only` : n'exporte que les centres (pas l'onglet Formations).
  - `--clean` ou `--clean-list` : limite aux centres « propres » (SIREN/SIRET/email valides + téléphone ou site).
  - `--created-after=2024-01-01` ou `--created-after 2024-01-01` : filtre sur la date de création (ISO).
  - `--single-file` : force la génération d'un unique fichier (désactive la découpe automatique en chunks ; attention à la taille !).
  - Par défaut, l'export génère un fichier par `searchQuery` et inclut le nom de la requête dans le nom du fichier (ex: `export_mcf_comptable-paris-mixte_YYYY-MM-DDTHH-MM-SS.xlsx`).
- `npm run db:clear` : vide les tables (utiliser avec prudence). Aucune option.
- `npm run prisma:generate` / `npm run prisma:migrate` : gestion du schéma Prisma. Options Prisma disponibles via `npx prisma --help`.
- `npm run build` puis `npm start` : compilation + exécution depuis `dist`. Pas d'option supplémentaire côté npm (transmettez vos variables d'environnement).
- `npm run lint` / `npm run format` : qualité du code, aucune option (mais vous pouvez cibler des fichiers via les options ESLint/Prettier standard en éditant la commande au besoin).

## Paramétrage des recherches

- Les requêtes "mixte" sont centrées sur Paris (et non plus sur une liste de villes).
- Le rayon de recherche mixte est configuré dans `src/config/searchQueries.ts` (actuellement `distance: "50000"`).

## Flux type

1. Préparer la base MySQL et exécuter `npm run prisma:migrate` (ou `npx prisma db push`).
2. Lancer `npm run extract -- --query=<thème>` pour peupler les formations.
3. Exécuter `npm run enrich` afin d’obtenir les détails (prix, description HTML, contenu, contacts).
4. Optionnel : `npm run export` pour générer un fichier de sortie.
5. `npm run sync:opendata` pour actualiser les fiches centres avec les données publiques.

Les logs sont écrits en console et dans `logs/` (via Winston). Ajuster `LOG_LEVEL` selon les besoins.

## Utilitaire RNCP (sans base)

Pour un lancement simple sous Windows, utilisez `run_rncp_listing.cmd`.

Ce tunnel :
- scrape les résultats CPF pour chaque code RNCP fourni,
- enchaîne automatiquement 2 modes pour chaque code : `présentiel` (Paris, distance non bornée) puis `distanciel`,
- agrège en mémoire par organisme (une seule ligne par organisme),
- nettoie les lignes bruitées (ex: organisme `ND`) puis déduplique les codes RNCP par organisme,
- enrichit ensuite les organismes avec les données OpenDataSoft (SIREN/SIRET quand disponibles),
- exporte un CSV dans `EXPORT_DIR` (par défaut `exports/`).
