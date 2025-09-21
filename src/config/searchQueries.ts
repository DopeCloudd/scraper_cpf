export type SearchQueryPayload = Record<string, unknown>;

export interface SearchQuery {
  name: string;
  payload: SearchQueryPayload;
}

export const searchQueries: SearchQuery[] = [
  {
    name: 'anglais-distance',
    payload: {
      ou: {
        modality: 'A_DISTANCE',
        type: 'CP',
      },
      debutPagination: 1,
      nombreOccurences: 10,
      contexteFormation: 'ACTIVITE_PROFESSIONNELLE',
      nomOrganisme: null,
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
        code: '15234',
        libelle: 'ANGLAIS',
        type: 'FORMACODE',
        publics: ['GD_PUBLIC'],
      },
    },
  },
  {
    name: 'bilan-competences-distance',
    payload: {
      ou: {
        modality: 'A_DISTANCE',
        type: 'CP'
      },
      debutPagination: 1,
      nombreOccurences: 10,
      contexteFormation: 'ACTIVITE_PROFESSIONNELLE',
      nomOrganisme: null,
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
        code: 'CPF202',
        libelle: 'BILAN DE COMPETENCES',
        type: 'CERTIFICATION',
        publics: ['GD_PUBLIC']
      },
    },
  },
  {
    name: 'vae-distance',
    payload: {
      ou: {
        modality: 'A_DISTANCE',
        type: 'CP'
      },
      debutPagination: 1,
      nombreOccurences: 10,
      contexteFormation: 'ACTIVITE_PROFESSIONNELLE',
      nomOrganisme: null,
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
        code: '44591',
        libelle: 'VALIDATION ACQUIS EXPERIENCE',
        type: 'FORMACODE',
        publics: ['GD_PUBLIC']
      },
    },
  },
  {
    name: 'allemand-distance',
    payload: {
      ou: {
        modality: 'A_DISTANCE',
        type: 'CP',
      },
      debutPagination: 1,
      nombreOccurences: 10,
      contexteFormation: 'ACTIVITE_PROFESSIONNELLE',
      nomOrganisme: null,
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
        code: '15287',
        libelle: 'ALLEMAND',
        type: 'FORMACODE',
        publics: ['GD_PUBLIC'],
      },
    },
  },
  {
    name: 'comptable-distance',
    payload: {
      ou: {
        modality: 'A_DISTANCE',
        type: 'CP',
      },
      debutPagination: 1,
      nombreOccurences: 10,
      contexteFormation: 'ACTIVITE_PROFESSIONNELLE',
      nomOrganisme: null,
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
        code: '32663',
        libelle: 'COMPTABLE',
        type: 'FORMACODE',
        publics: ['GD_PUBLIC'],
      },
    },
  },
];
