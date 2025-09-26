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
- `npm run extract [-- --query=<nom> ...]` : scrape des formations depuis MonCompteFormation.
  - Sans option, toutes les requêtes de `searchQueries.ts` sont exécutées.
  - `--query=anglais` lance toutes les variantes dont le nom commence par `anglais-` (villes + distance).
  - `--query=anglais-paris-mixte` cible une requête précise.
  - Les options sont cumulables : `--query=anglais --query=marketing-lyon-mixte`.
- `npm run enrich` : visite les fiches en attente pour récupérer les détails (contacts, description HTML, etc.).
- `npm run sync:opendata` : synchronise les données centres depuis l'open data.
- `npm run export` : génère un fichier dans `EXPORT_DIR` (CSV/Excel selon implémentation).
- `npm run db:clear` : vide les tables (utiliser avec prudence).
- `npm run prisma:generate` / `npm run prisma:migrate` : gestion du schéma Prisma.
- `npm run build` puis `npm start` : compilation + exécution depuis `dist`.
- `npm run lint` / `npm run format` : qualité du code.

## Flux type
1. Préparer la base MySQL et exécuter `npm run prisma:migrate` (ou `npx prisma db push`).
2. Lancer `npm run extract -- --query=<thème>` pour peupler les formations.
3. Exécuter `npm run enrich` afin d’obtenir les détails (prix, description HTML, contacts).
4. Optionnel : `npm run export` pour générer un fichier de sortie.
5. `npm run sync:opendata` pour actualiser les fiches centres avec les données publiques.

Les logs sont écrits en console et dans `logs/` (via Winston). Ajuster `LOG_LEVEL` selon les besoins.
